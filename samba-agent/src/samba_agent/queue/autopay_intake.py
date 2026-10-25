"""무신사 자동결제 접수 — 삼바의 자동결제 대상을 큐에 넣는다(사용자 지시 2026-10-06 ①탐색).

한 바퀴(`run_once`)가 하는 일:
1. 삼바 `autopay/queue` 에서 대상(무신사·대기·'자동결제'+직배/까대기 선택·소싱주문번호 없음)을 받는다.
2. 이미 살아 있는 주문은 건너뛴다(같은 주문을 두 번 사지 않는다).
3. 대상마다 삼바 `refresh` 로 계정별 최저가를 **삼바 로직으로** 새로 비교한다(가격 요소는 일반쿠폰·장바구니쿠폰·LV 할인/적립·
   무신사머니 적립률 전부 삼바가 계산). 더 싼 계정이 나오면 그 계정을 쓴다. 준비가 안 됐으면 사유만 남기고 접수하지 않는다.
4. 준비된 주문은 옵션 autopay=1 로 큐에 넣는다 — 구매는 지시서의 계정으로, 결제 전 판정과 결제 후 입력은 삼바가 한다.
개인정보(배송지·연락처)는 큐·슬랙에 싣지 않는다.
"""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from samba_agent.agents.autopay import MONEY_METHOD, OPT_FLAG, OPT_USERNAME
from samba_agent.queue.db import Job, JobQueue
from samba_agent.wave.client import WaveClient, WaveError

log = logging.getLogger(__name__)

TICK_S = 0.5
# 준비 안 된 주문(계정 비교 미완료 등)은 이만큼 쉬었다가 다시 재비교한다 — 2분마다 12개 계정을 다시 조회하면 소싱처 호출 예산을 쓴다
NOT_READY_COOLDOWN_S = 15 * 60
# 사람이 손대지 않아도 풀리는 결제 전 막힘 — 앱이 바쁘거나 꺼짐(bridge_down), 로그인 페이지가 응답 없음·금고 잠김(permission_denied).
# 구매 에이전트가 이 사유로 끝나면 결제 에이전트까지 가지 않았으므로 다시 시도해도 이중 결제가 없다. 결제 중 사유(pay_interrupted)·
# 확정 사유(품절·마진·대조 불일치·알 수 없음)는 절대 자동으로 되살리지 않는다 — 사람이 정한다.
RETRYABLE_REASONS = frozenset({'bridge_down', 'permission_denied'})
RETRY_REST_S = 10 * 60  # 막힌 뒤 이만큼 쉬었다가 다시 — 앱이 풀릴 시간을 준다
MAX_AUTO_RETRIES = 3  # 자동 재시도 상한(처음 시도 포함 4번) — 넘으면 사람에게 남는다


@dataclass(frozen=True)
class AutopayReport:
    seen: int = 0
    enqueued: int = 0
    skipped_live: int = 0
    not_ready: int = 0
    retried: int = 0

    def as_line(self) -> str:
        return (
            f'자동결제 대상 {self.seen}건 · 접수 {self.enqueued}건(재시도 {self.retried}) · '
            f'진행중 제외 {self.skipped_live}건 · 준비 안 됨 {self.not_ready}건'
        )


def _kind_of_problems(problems: str) -> str:
    """준비 안 된 사유가 시간이 풀어 주는 것(비교가 덜 끝남)이면 info, 사람이 고쳐야 하면 action."""
    return 'info' if '덜 끝났' in problems else 'action'


def intake_line(brief: dict[str, object]) -> str:
    """슬랙 최상위 한 줄 — 개인정보 없음."""
    expected = brief.get('expected') if isinstance(brief.get('expected'), dict) else {}
    account = brief.get('account') if isinstance(brief.get('account'), dict) else {}
    refresh = brief.get('refresh') if isinstance(brief.get('refresh'), dict) else {}
    line = f'자동결제 접수: {brief.get("order_number")} · 무신사 · 계정 {account.get("username")} · 예상 매입가 {expected.get("net_cost")}원'
    if refresh.get('cheaper'):
        line += f' · 간단메모보다 {abs(int(refresh.get("change") or 0))}원 저렴(삼바 재비교)'
    return line


def options_for(brief: dict[str, object]) -> dict[str, object]:
    """큐 작업 옵션 — 구매는 삼바가 정한 계정 하나, 결제수단은 무신사머니, 교차 비교(29CM)는 하지 않는다."""
    account = brief.get('account') if isinstance(brief.get('account'), dict) else {}
    return {
        OPT_FLAG: '1',
        OPT_USERNAME: str(account.get('username') or ''),
        'card': MONEY_METHOD,
        'no_cross': '1',
    }


class AutopayIntake:
    """삼바 자동결제 대상 → 큐 접수 고리."""

    def __init__(
        self,
        wave: WaveClient,
        queue: JobQueue,
        post_new: Callable[[str], str | None],
        post_line: Callable[[str | None, str], bool],
        *,
        max_new: int = 3,
        requester: str = 'autopay',
        cooldown_s: float = NOT_READY_COOLDOWN_S,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], datetime] = lambda: datetime.now(UTC),
        retry_rest_s: float = RETRY_REST_S,
    ) -> None:
        self._wave = wave
        self._queue = queue
        self._post_new = post_new
        self._post_line = post_line
        self._max_new = max_new
        self._requester = requester
        self._cooldown_s = cooldown_s
        self._clock = clock
        self._wall = wall
        self._retry_rest_s = retry_rest_s
        self._retry_after: dict[str, float] = {}
        # 준비 안 된 사유를 주기마다 되풀이해 올리지 않는다(주문번호 → 마지막으로 올린 사유)
        self._reported: dict[str, str] = {}
        self.paused = False

    def _note(self, order_no: str, kind: str, text: str) -> None:
        """삼바 주문의 자동결제 칸에 상태를 적는다 — 실패해도 접수를 막지 않는다."""
        try:
            self._wave.autopay_status(order_no, kind, text)
        except Exception as e:  # noqa: BLE001 — 칸을 못 적어도 접수·재시도는 계속된다
            log.warning('자동결제 칸에 적지 못했다 %s: %s', order_no, e)

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def run_once(self) -> AutopayReport:
        if self.paused:
            return AutopayReport()
        try:
            targets = self._wave.autopay_queue(limit=20)
        except WaveError as e:
            log.warning('자동결제 대상 조회 실패 — 다음 주기에 다시 해본다: %s', e)
            return AutopayReport()
        seen = enqueued = skipped_live = not_ready = retried = 0
        for target in targets:
            seen += 1
            order_no = str(target.get('order_number') or '')
            if not order_no:
                continue
            job = self._queue.get(order_no)
            revive = job is not None and self._retryable(job)
            if job is not None and not revive:
                skipped_live += 1
                continue
            if self._clock() < self._retry_after.get(order_no, 0.0):
                not_ready += 1
                continue
            if enqueued >= self._max_new:
                break
            try:
                brief = self._wave.autopay_refresh(order_no)
            except WaveError as e:
                log.warning('자동결제 최저가 재확인 실패 %s: %s', order_no, e)
                self._retry_after[order_no] = self._clock() + self._cooldown_s
                not_ready += 1
                self._note(order_no, 'info', f'삼바 최저가 재확인이 늦어 {int(self._cooldown_s // 60)}분 뒤 다시 합니다')
                continue
            if not brief.get('ready'):
                self._retry_after[order_no] = self._clock() + self._cooldown_s
                not_ready += 1
                problems = '; '.join(str(p) for p in (brief.get('problems') or []))[:200]
                if self._reported.get(order_no) != problems:
                    self._reported[order_no] = problems
                    self._post_new(f'자동결제 대기: {order_no} — {problems}')
                    log.info('자동결제 준비 안 됨 %s: %s', order_no, problems)
                    self._note(order_no, _kind_of_problems(problems), problems)
                continue
            self._reported.pop(order_no, None)
            self._retry_after.pop(order_no, None)
            if revive and job is not None:
                try:
                    self._queue.retry(
                        job.id, max_attempts=MAX_AUTO_RETRIES + 1, options=options_for(brief)
                    )
                except ValueError:
                    skipped_live += 1
                    continue
                self._post_new(
                    f'자동결제 재시도 {job.attempts + 1}/{MAX_AUTO_RETRIES}: {order_no} — '
                    f'이전 막힘({job.error}) 뒤 {int(self._retry_rest_s // 60)}분 쉬고 다시'
                )
                retried += 1
                self._note(order_no, 'clear', '')  # 이전 막힘 줄은 다시 시작하며 지운다 — 또 막히면 새 줄이 적힌다
            else:
                ts = self._post_new(intake_line(brief))
                self._queue.enqueue(order_no, self._requester, options_for(brief), thread_ts=ts)
                self._note(order_no, 'clear', '')
            enqueued += 1
        return AutopayReport(
            seen=seen,
            enqueued=enqueued,
            skipped_live=skipped_live,
            not_ready=not_ready,
            retried=retried,
        )

    def _retryable(self, job: Job) -> bool:
        """결제 전 막힘(앱 busy·로그인 응답 없음)으로 끝난 건은 쉬었다가 다시 한다. 그 밖에 큐에 있는 주문은 모두 건너뛴다 —
        needs_human·failed 로 끝난 건이 매 주기 되살아나 재결제로 이어지지 않게 한다(다시 돌리는 것은 사람의 결정, 슬랙 `이어서`)."""
        if job.state not in ('needs_human', 'failed') or (job.error or '') not in RETRYABLE_REASONS:
            return False
        if job.attempts >= MAX_AUTO_RETRIES:
            return False
        try:
            ended = datetime.fromisoformat(job.updated_at)
        except ValueError:
            return False
        return (self._wall() - ended).total_seconds() >= self._retry_rest_s

    def run_forever(self, stop: Callable[[], bool], interval_s: float) -> None:
        while not stop():
            try:
                self.run_once()
            except Exception:
                log.exception('자동결제 접수 한 바퀴가 실패했다 — 다음 주기로 넘어간다')
            waited = 0.0
            while waited < interval_s and not stop():
                time.sleep(TICK_S)
                waited += TICK_S
