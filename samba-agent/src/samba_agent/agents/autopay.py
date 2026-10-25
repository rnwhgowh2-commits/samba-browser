"""무신사 자동결제 — 삼바(판정) ↔ 삼바 브라우저(실행) 연결(사용자 지시 2026-10-06).

계정별 최저가·결제 조건·결제 후 입력과 정상/비정상 판정은 모두 삼바가 한다(`/internal/harness/autopay/*`).
하네스는 지시서대로 사고, 주문서에서 읽은 값을 삼바에 보내고, 결제 뒤 무신사 주문상세를 읽어 보내기만 한다.

- 구매 에이전트(buyer.py)가 autopay 옵션이면 계정을 지시서의 것으로 고정하고(하네스 자체 계정 비교 없음),
  주문서를 정돈한 뒤 삼바 `verify` 로 결제 가능 여부를 받는다. 개인정보(배송지)는 보내지 않는다 —
  하네스가 입력 후 되읽어 이미 대조했다는 사실(shipping_verified)만 보낸다.
- 기록 에이전트(AutopayRecorderAgent)는 결제 뒤 주문상세 JSON 을 읽어 삼바 `result` 로 보낸다. 정상이면 삼바가
  금액·주문상태 칼럼을 채우고, 비정상이면 '자동결제 정보이상'(주문 행 빨간 테두리·금액칸 버튼)을 켠다.
- 결제 비밀번호는 여기서 다루지 않는다(결제 에이전트가 키마스터 금고로 입력한다).
"""

import json
import re

from samba_agent.agents.base import AgentBase, AgentFailure, run_agent
from samba_agent.agents.contracts import AgentResult, Assignment
from samba_agent.failures import FailReason
from samba_agent.ops.masking import mask_text
from samba_agent.wave.client import WaveClient, WaveError

# 작업 옵션 키 — 접수(autopay_intake)가 싣고 구매·기록이 읽는다
OPT_FLAG = 'autopay'
OPT_USERNAME = 'autopay_username'
# 결제수단은 무신사머니만(사용자 지시) — 주문서 결제수단 라벨
MONEY_METHOD = '무신사머니'
DETAIL_URL = 'https://www.musinsa.com/order-service/my/order/get_order_view/{no}'
_ORDER_NO = re.compile(r'^[0-9]{14,24}$')


def is_autopay(options: object) -> bool:
    return isinstance(options, dict) and str(options.get(OPT_FLAG) or '') == '1'


def label_for(username: str, labels: list[str]) -> str | None:
    """삼바의 계정 아이디 → 키마스터 라벨. 라벨은 아이디 그대로이거나 '무신사_아이디' 처럼 접두어가 붙는다.

    정확히 같은 라벨이 있으면 그것, 없으면 '_아이디' 로 끝나는 라벨. 여럿이면 None(사람이 정한다).
    """
    want = username.strip().lower()
    if not want:
        return None
    lowered = [(label, label.strip().lower()) for label in labels]
    exact = [label for label, low in lowered if low == want or low.split('@')[0] == want]
    if len(exact) == 1:
        return exact[0]
    suffix = [label for label, low in lowered if low.endswith('_' + want)]
    return suffix[0] if not exact and len(suffix) == 1 else None


def _int(value: object) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def receipt_from_view(view: object) -> dict[str, object]:
    """무신사 주문상세(get_order_view) JSON → 삼바 result 입력. 형식이 다르거나 상품이 하나가 아니면 ValueError.

    연락처는 싣지 않는다(삼바가 대조하지 않는다). 수령인·주소는 삼바가 배송지 대조에 쓴다.
    """
    if not isinstance(view, dict) or view.get('result') != 'SUCCESS':
        raise ValueError('주문상세 응답이 SUCCESS 가 아니다')
    info = view.get('orderInfo') or {}
    listing = view.get('orderList') or {}
    items = listing.get('orderOptionList') or []
    number = str(listing.get('orderNo') or '')
    if (
        not isinstance(info, dict)
        or not _ORDER_NO.match(number)
        or str(info.get('ord_no') or '') != number
    ):
        raise ValueError('주문번호가 상세 응답과 맞지 않는다')
    if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
        raise ValueError('주문 상품이 하나가 아니다')
    item = items[0]
    receipt: dict[str, object] = {
        'order_number': number,
        'order_state': _int(item.get('orderState')),
        'claim_state': _int(item.get('claimState')),
        'pay_kind': str(info.get('pay_kind') or ''),
        'cash_payment': _int(info.get('recv_amt')),
        'used_points': _int(info.get('use_point_amt')),
        'product_id': str(item.get('goodsNo') or ''),
        'option': str(item.get('goodsOption') or item.get('originGoodsOption') or ''),
        'quantity': _int(item.get('quantity')),
        'user_id': str(info.get('user_id') or ''),
        'receiver_name': str(info.get('r_nm') or ''),
        'shipping_address1': str(info.get('r_addr1') or ''),
        'shipping_address2': str(info.get('r_addr2') or ''),
        'order_datetime': str(listing.get('orderDatetime') or ''),
    }
    if receipt['order_state'] is None or receipt['claim_state'] is None:
        raise ValueError('주문 상태를 읽지 못했다')
    return receipt


def read_view_code(order_no: str, profile: str | None) -> str:
    """주문상세 JSON 을 새 탭에서 읽어 오는 run_js 코드(읽기 전용). 주문번호는 숫자만 허용한다."""
    if not _ORDER_NO.match(order_no):
        raise ValueError('주문번호 형식 오류')
    url = json.dumps(DETAIL_URL.format(no=order_no), ensure_ascii=False)
    pf = f'profile: {json.dumps(profile, ensure_ascii=False)}, ' if profile else ''
    return (
        'const opened = []\n'
        'try {\n'
        f'  const id = (String(await tabs.open({{ {pf}url: {url} }})).match(/tab (\\S+)/) || [])[1]\n'
        '  if (id) { opened.push(id); await tabs.switch(id) }\n'
        "  let txt = ''\n"
        '  for (let i = 0; i < 8; i++) {\n'
        '    await sleep(800)\n'
        "    try { const t = (await page.get({})).tree; txt = String(t.split('PAGE TEXT:')[1] || '').trim() } catch (e) {}\n"
        "    if (txt.startsWith('{') && txt.includes('\"result\"')) break\n"
        '  }\n'
        '  return txt\n'
        '} finally { for (const id of opened) { try { await tabs.close(id) } catch (e) {} } }\n'
    )


class AutopayRecorderAgent(AgentBase):
    """결제 뒤 무신사 주문상세를 읽어 삼바에 보낸다. 입력·정상/비정상 판정은 삼바가 한다. 재결제는 절대 하지 않는다."""

    _wave: WaveClient | None = None

    def set_wave(self, wave: WaveClient | None) -> None:
        self._wave = wave

    def __call__(self, assignment: Assignment) -> AgentResult:
        self.reset_repairs()
        return run_agent(lambda: self._record(assignment), lambda: self.evidence)

    def _record(self, a: Assignment) -> AgentResult:
        self.evidence = []
        if self._wave is None:
            raise AgentFailure(
                'needs_human',
                '삼바 연결이 없어 자동결제 결과를 입력하지 못했다(결제됨, 기록만 남음)',
                FailReason.UNKNOWN,
            )
        number = str(
            a.handoff.get('source_order_no') or a.expected.get('source_order_no') or ''
        ).strip()
        if not _ORDER_NO.match(number):
            raise AgentFailure(
                'needs_human',
                '결제 뒤 무신사 주문번호를 받지 못했다(결제됨, 기록만 남음)',
                FailReason.UNKNOWN,
            )
        account = str(a.handoff.get('account') or '') or None
        self.step('autopay_recorder: 무신사 주문상세 읽기')
        try:
            raw = self.tool('run_js', code=read_view_code(number, account), safety='no_pay')
            receipt = receipt_from_view(json.loads(_json_text(raw)))
        except (ValueError, json.JSONDecodeError) as e:
            raise AgentFailure(
                'needs_human',
                f'무신사 주문상세를 읽지 못했다(결제됨, 기록만 남음): {mask_text(str(e)[:80])}',
                FailReason.UNKNOWN,
            ) from e
        if receipt['order_number'] != number:
            raise AgentFailure(
                'needs_human',
                '주문상세의 주문번호가 결제 화면과 다르다(결제됨, 기록만 남음)',
                FailReason.VERIFY_MISMATCH,
            )
        self.step('autopay_recorder: 삼바에 입력·판정')
        try:
            out = self._wave.autopay_result(a.order.order_no, receipt)
        except WaveError as e:
            raise AgentFailure(
                'needs_human',
                f'삼바 입력 실패(결제됨, 기록만 남음): {mask_text(str(e)[:120])}',
                e.reason,
            ) from e
        problems = [str(p) for p in (out.get('problems') or [])]
        payload = {
            'autopay_recorded': True,
            'source_order_no': number,
            'cost': out.get('cost'),
            'real_price': out.get('cost'),
        }
        if out.get('ok'):
            self.note('삼바 입력', f'정상 — 실구매가 {out.get("cost")}원 저장')
            return AgentResult(
                status='ok',
                reason=f'삼바에 입력, 정상 판정(실구매가 {out.get("cost")}원)',
                payload=payload,
            )
        # 결제는 끝났다 — 삼바가 정보이상 표시(빨간 테두리·금액칸 버튼)를 켰다. 사람이 확인한다
        return AgentResult(
            status='needs_human',
            reason='자동결제 정보이상 — ' + '; '.join(problems)[:300],
            payload={**payload, 'issue_tagged': bool(out.get('issue_tagged'))},
            fail_reason=FailReason.VERIFY_MISMATCH,
        )


class AutopayVerifierAgent(AgentBase):
    """검증은 삼바가 결과 입력에서 이미 했다. 기록이 정상으로 끝난 건만 여기까지 온다."""

    def __call__(self, assignment: Assignment) -> AgentResult:
        return AgentResult(
            status='ok',
            reason='삼바가 결제 후 대조를 마쳤다(autopay)',
            payload={'autopay_verified': True},
        )


def _json_text(raw: str) -> str:
    """run_js 결과에서 JSON 본문만(앞에 붙는 로그·알림 줄 제거)."""
    start = raw.find('{')
    end = raw.rfind('}')
    if start < 0 or end <= start:
        raise ValueError('주문상세 본문이 JSON 이 아니다')
    return raw[start : end + 1]
