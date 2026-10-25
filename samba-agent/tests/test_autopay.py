# 무신사 자동결제 연동 — 삼바가 판정·입력하고 하네스는 실행만 한다(사용자 지시 2026-10-06)
import json
from datetime import UTC, datetime, timedelta

import pytest

from samba_agent.agents import autopay
from samba_agent.agents.autopay import AutopayRecorderAgent, AutopayVerifierAgent
from samba_agent.agents.base import AgentFailure
from samba_agent.agents.buyer import BuyerAgent
from samba_agent.agents.contracts import AgentResult, Assignment, OrderRef
from samba_agent.agents.registry import Registry
from samba_agent.failures import FailReason
from samba_agent.queue.autopay_intake import AutopayIntake, intake_line, options_for
from samba_agent.queue.db import JobQueue
from samba_agent.queue.intake import Intake
from samba_agent.settings import DEFAULT_ROOT
from samba_agent.supervisor.graph import build_supervisor
from samba_agent.supervisor.policy import check_buyer_autopay
from samba_agent.wave.client import WaveError, WaveOrder

ORDER = OrderRef(
    order_no='20261005106126238',
    source='무신사',
    seller='11번가',
    sku='후아유 후드집업',
    qty=1,
    option='S(085)',
)


def view(**over) -> dict:
    """무신사 get_order_view 응답(2026-10-06 실측 모양, 값은 가짜)."""
    base = {
        'result': 'SUCCESS',
        'orderList': {
            'orderNo': '202610060000001',
            'orderDatetime': '2026-10-06 10:00:30',
            'orderOptionList': [
                {
                    'orderState': 10,
                    'claimState': 0,
                    'goodsNo': 7140449,
                    'goodsOption': 'S(085)',
                    'quantity': 1,
                }
            ],
        },
        'orderInfo': {
            'ord_no': '202610060000001',
            'recv_amt': '40000',
            'use_point_amt': '7820',
            'pay_kind': 'MUSINSAPAY_MONEY',
            'user_id': 'rnwhgowh',
            'r_nm': '홍길동',
            'r_mobile': '010-0000-0000',
            'r_addr1': '서울 강서구 테스트로 1',
            'r_addr2': '101호',
        },
    }
    return base | over


# ───── 순수 함수 ─────
@pytest.mark.parametrize(
    'username,labels,expected',
    [
        ('rnwhgowh', ['무신사_rnwhgowh', 'cdhking00', 'rnwhgowh1'], '무신사_rnwhgowh'),
        ('rnwhgowh1', ['무신사_rnwhgowh', 'rnwhgowh1'], 'rnwhgowh1'),
        ('rnwhgowh', ['rnwhgowh', '무신사_rnwhgowh'], 'rnwhgowh'),  # 정확히 같은 라벨이 먼저
        ('RNWHGOWH', ['무신사_rnwhgowh'], '무신사_rnwhgowh'),
        ('buyer01', ['buyer01@naver.com'], 'buyer01@naver.com'),
        ('rnwhgowh', ['a_rnwhgowh', 'b_rnwhgowh'], None),  # 여럿이면 사람이 정한다
        ('nobody', ['무신사_rnwhgowh'], None),
        ('', ['x'], None),
    ],
)
def test_label_for(username, labels, expected):
    assert autopay.label_for(username, labels) == expected


def test_receipt_from_view_keeps_only_what_samba_judges_and_drops_the_phone():
    receipt = autopay.receipt_from_view(view())
    assert receipt == {
        'order_number': '202610060000001',
        'order_state': 10,
        'claim_state': 0,
        'pay_kind': 'MUSINSAPAY_MONEY',
        'cash_payment': 40000,
        'used_points': 7820,
        'product_id': '7140449',
        'option': 'S(085)',
        'quantity': 1,
        'user_id': 'rnwhgowh',
        'receiver_name': '홍길동',
        'shipping_address1': '서울 강서구 테스트로 1',
        'shipping_address2': '101호',
        'order_datetime': '2026-10-06 10:00:30',
    }
    assert 'receiver_mobile' not in receipt and 'receiver_phone' not in receipt


@pytest.mark.parametrize(
    'bad',
    [
        None,
        'text',
        {},
        view(result='FAIL'),
        view(orderList={'orderNo': '202610060000001', 'orderOptionList': [{}, {}]}),
        view(
            orderList={
                'orderNo': '202610060000009',
                'orderOptionList': [{'orderState': 10, 'claimState': 0}],
            }
        ),
        view(
            orderList={'orderNo': 'abc', 'orderOptionList': [{'orderState': 10, 'claimState': 0}]}
        ),
    ],
)
def test_receipt_from_view_rejects_unusable_responses(bad):
    with pytest.raises(ValueError):
        autopay.receipt_from_view(bad)


def test_read_view_code_is_read_only_and_only_accepts_digits():
    code = autopay.read_view_code('202610060000001', '무신사_rnwhgowh')
    assert 'get_order_view/202610060000001' in code and '무신사_rnwhgowh' in code
    assert 'click' not in code and 'type(' not in code and 'fill' not in code
    assert 'tabs.close' in code  # 열어 본 탭은 닫는다
    for bad in ('', 'abc', '2026"; alert(1); "', '12345'):
        with pytest.raises(ValueError):
            autopay.read_view_code(bad, None)


def test_options_and_intake_line_carry_no_personal_data():
    brief = {
        'order_number': '20261005106126238',
        'account': {'username': 'rnwhgowh'},
        'expected': {'net_cost': 44090},
        'refresh': {'cheaper': True, 'change': -790},
        'shipping': {'name': '홍길동', 'address': '서울 어딘가'},
    }
    assert options_for(brief) == {
        'autopay': '1',
        'autopay_username': 'rnwhgowh',
        'card': '무신사머니',
        'no_cross': '1',
    }
    line = intake_line(brief)
    assert '44090' in line and '790원 저렴' in line and '홍길동' not in line and '서울' not in line


# ───── 감독자 검사 ─────
def test_check_buyer_autopay_requires_the_samba_verdict_and_a_card():
    ok = AgentResult(
        status='ok',
        reason='r',
        payload={'autopay_verified': True, 'card': '무신사머니', 'margin_pct': -50},
    )
    assert (
        check_buyer_autopay(ok).status == 'ok'
    )  # 마진은 삼바가 판정했다 — 하네스 마진은 보지 않는다
    no_verdict = AgentResult(status='ok', reason='r', payload={'card': '무신사머니'})
    out = check_buyer_autopay(no_verdict)
    assert out.status == 'needs_human' and out.fail_reason is FailReason.VERIFY_MISMATCH
    no_card = AgentResult(status='ok', reason='r', payload={'autopay_verified': True})
    assert check_buyer_autopay(no_card).fail_reason is FailReason.CARD_MISSING
    failed = AgentResult(status='fail', reason='x', fail_reason=FailReason.UNKNOWN)
    assert check_buyer_autopay(failed) is failed


# ───── 기록 에이전트 ─────
class _Out:
    def __init__(self, result: str) -> None:
        self.result = result


class _Bridge:
    """AgentBase 가 쥐는 브릿지 — 호출을 기록하고 정해 둔 답을 돌려준다."""

    def __init__(self, replies: dict[str, str]) -> None:
        self.replies = replies
        self.calls: list[tuple[str, dict]] = []

    def scoped(self, _tools):
        return self

    def call(self, name, **args):
        self.calls.append((name, args))
        return _Out(self.replies.get(name, 'ok'))


class _Wave:
    def __init__(self, result=None, error: WaveError | None = None) -> None:
        self.result, self.error, self.posted = result or {}, error, []

    def autopay_result(self, order_no, receipt):
        self.posted.append((order_no, receipt))
        if self.error:
            raise self.error
        return self.result


@pytest.fixture()
def reg():
    return Registry.load(DEFAULT_ROOT)


def recorder(reg, bridge, wave):
    agent = AutopayRecorderAgent(reg['autopay_recorder'], bridge, lambda *_: None)
    agent.set_wave(wave)
    return agent


def paid_assignment(reg, **handoff) -> Assignment:
    spec = reg['autopay_recorder']
    return Assignment(
        order=ORDER,
        options={'autopay': '1'},
        allowed_tools=spec.tools,
        rules='r',
        dry_run=False,
        handoff={'source_order_no': '202610060000001', 'account': '무신사_rnwhgowh', **handoff},
    )


def test_recorder_sends_the_receipt_and_reports_normal(reg):
    bridge = _Bridge({'run_js': json.dumps(view())})
    wave = _Wave({'ok': True, 'saved': True, 'problems': [], 'cost': 44090})
    result = recorder(reg, bridge, wave)(paid_assignment(reg))
    assert (
        result.status == 'ok'
        and result.payload['cost'] == 44090
        and result.payload['autopay_recorded'] is True
    )
    assert (
        wave.posted[0][0] == ORDER.order_no
        and wave.posted[0][1]['order_number'] == '202610060000001'
    )
    args = next(a for n, a in bridge.calls if n == 'run_js')
    assert args['safety'] == 'no_pay' and '무신사_rnwhgowh' in args['code']


def test_recorder_turns_a_samba_abnormal_verdict_into_a_human_check_never_a_retry(reg):
    bridge = _Bridge({'run_js': 'log: x\n' + json.dumps(view())})
    wave = _Wave(
        {
            'ok': False,
            'saved': True,
            'problems': ['배송지가 다릅니다', '결제액이 다릅니다'],
            'cost': 44000,
            'issue_tagged': True,
        }
    )
    result = recorder(reg, bridge, wave)(paid_assignment(reg))
    assert result.status == 'needs_human' and result.fail_reason is FailReason.VERIFY_MISMATCH
    assert result.reason.startswith('자동결제 정보이상') and '배송지가 다릅니다' in result.reason
    assert result.payload['issue_tagged'] is True and len(wave.posted) == 1


@pytest.mark.parametrize(
    'handoff,replies,wave',
    [
        ({'source_order_no': ''}, {}, _Wave()),  # 결제 뒤 주문번호 없음
        ({}, {'run_js': 'not json'}, _Wave()),  # 주문상세를 못 읽음
        ({}, {'run_js': json.dumps(view(result='FAIL'))}, _Wave()),
        (
            {},
            {'run_js': json.dumps(view())},
            _Wave(error=WaveError(FailReason.BRIDGE_DOWN, '삼바 연결 실패')),
        ),
    ],
)
def test_recorder_failures_always_say_paid_record_only_and_never_pay_again(
    reg, handoff, replies, wave
):
    handoff = {'source_order_no': '202610060000001'} | handoff
    result = recorder(reg, _Bridge(replies), wave)(paid_assignment(reg, **handoff))
    assert result.status == 'needs_human' and '결제됨, 기록만 남음' in result.reason


def test_recorder_refuses_a_receipt_whose_number_differs_from_the_payment_screen(reg):
    mismatched = view(
        orderList={
            'orderNo': '202610060000002',
            'orderDatetime': 'x',
            'orderOptionList': [{'orderState': 10, 'claimState': 0}],
        },
        orderInfo={**view()['orderInfo'], 'ord_no': '202610060000002'},
    )
    wave = _Wave()
    result = recorder(reg, _Bridge({'run_js': json.dumps(mismatched)}), wave)(paid_assignment(reg))
    assert (
        result.status == 'needs_human'
        and result.fail_reason is FailReason.VERIFY_MISMATCH
        and wave.posted == []
    )


def test_autopay_agents_are_picked_only_for_autopay_jobs(reg):
    assert reg.pick('recorder', ORDER, {'autopay': '1'}).name == 'autopay_recorder'
    assert reg.pick('verifier', ORDER, {'autopay': '1'}).name == 'autopay_verifier'
    assert (
        reg.pick('recorder', ORDER, {}).name == 'recorder'
        and reg.pick('verifier', ORDER, {}).name == 'verifier'
    )
    verifier = AutopayVerifierAgent(reg['autopay_verifier'], _Bridge({}), lambda *_: None)
    assert verifier(paid_assignment(reg)).payload == {'autopay_verified': True}


# ───── 구매 에이전트의 자동결제 접점 ─────
def buyer(reg, replies, wave=None) -> BuyerAgent:
    spec = reg['buyer.musinsa']
    agent = BuyerAgent(spec, _Bridge(replies), lambda *_: None)
    agent.set_wave(wave)
    return agent


def buy_assignment(reg, **options) -> Assignment:
    spec = reg['buyer.musinsa']
    return Assignment(
        order=ORDER,
        options={'autopay': '1', 'autopay_username': 'rnwhgowh', 'card': '무신사머니', **options},
        allowed_tools=spec.tools,
        rules='r',
        dry_run=True,
    )


ACCOUNTS = json.dumps(
    [
        {'label': '무신사_rnwhgowh', 'username': 'rn***', 'types': ['login'], 'payments': ['site']},
        {'label': 'rnwhgowh1', 'username': 'rn***', 'types': ['login'], 'payments': []},
    ]
)


def test_buyer_uses_only_the_account_samba_chose_and_skips_the_harness_comparison(reg):
    agent = buyer(reg, {'list_accounts': ACCOUNTS})
    # 무신사는 buy_accounts(buyer01..)로 하네스가 직접 비교하지만, 자동결제는 삼바가 정한 한 계정만 쓴다
    assert agent._candidate_accounts(buy_assignment(reg)) == ['무신사_rnwhgowh']
    names = [c[0] for c in agent.bridge.calls]
    assert 'new_tab' in names and 'list_accounts' in names and 'run_script' not in names


@pytest.mark.parametrize(
    'options,replies',
    [
        ({'autopay_username': ''}, {'list_accounts': ACCOUNTS}),
        ({'autopay_username': 'nobody'}, {'list_accounts': ACCOUNTS}),
        ({}, {'list_accounts': 'locked: 키마스터 잠금 해제 필요'}),
    ],
)
def test_buyer_hands_over_to_a_human_when_the_samba_account_cannot_be_resolved(
    reg, options, replies
):
    agent = buyer(reg, replies)
    with pytest.raises(AgentFailure) as exc:
        agent._candidate_accounts(buy_assignment(reg, **options))
    assert exc.value.status == 'needs_human'


class _VerifyWave:
    def __init__(self, verdict) -> None:
        self.verdict, self.sent = verdict, []

    def autopay_verify(self, order_no, observed):
        self.sent.append((order_no, observed))
        if isinstance(self.verdict, Exception):
            raise self.verdict
        return self.verdict


SNAP = {
    'prep_total': 40000.0,
    'points_used': 7820.0,
    'prep_coupon': 12580.0,
    'prep_cart_coupon': 2510.0,
}


def test_buyer_sends_amounts_and_the_shipping_verified_fact_but_never_personal_data(reg):
    wave = _VerifyWave({'pay': True, 'reasons': [], 'net_cost': 44090})
    out = buyer(reg, {}, wave)._autopay_verify(
        buy_assignment(reg), SNAP, 'S(085)', '무신사머니', '7140449'
    )
    assert out == {'autopay_verified': True, 'autopay_net_cost': 44090}
    order_no, observed = wave.sent[0]
    assert order_no == ORDER.order_no
    assert observed == {
        'username': 'rnwhgowh',
        'product_id': '7140449',
        'quantity': 1,
        'option': 'S(085)',
        'product_coupon': {'discount': 12580},
        'cart_coupon': {'discount': 2510},
        'payment_method': 'MUSINSAPAY_MONEY',
        'pay_amount_before_points': 47820,
        'shipping_verified': True,
    }
    assert not any(
        k in observed for k in ('receiver_name', 'receiver_phone', 'address1', 'address2')
    )


@pytest.mark.parametrize(
    'card,snap,verdict,needle',
    [
        (
            '무신사머니',
            SNAP,
            {'pay': False, 'reasons': ['결제액이 100원 넘게 다릅니다']},
            '결제액이 100원',
        ),
        (
            '현대카드',
            SNAP,
            {'pay': True, 'reasons': [], 'net_cost': 1},
            '무신사머니',
        ),  # 머니만 허용
        ('무신사머니', {**SNAP, 'prep_total': 0.0}, {'pay': True, 'reasons': []}, '결제액을 읽지'),
        (
            '무신사머니',
            SNAP,
            WaveError(FailReason.BRIDGE_DOWN, '삼바웨이브 연결 실패'),
            '판정 실패',
        ),
    ],
)
def test_buyer_never_proceeds_to_payment_unless_samba_says_pay(reg, card, snap, verdict, needle):
    with pytest.raises(AgentFailure) as exc:
        buyer(reg, {}, _VerifyWave(verdict))._autopay_verify(
            buy_assignment(reg), snap, 'S(085)', card, '7140449'
        )
    assert exc.value.status == 'needs_human' and needle in exc.value.reason


def test_buyer_without_a_samba_connection_cannot_autopay(reg):
    with pytest.raises(AgentFailure):
        buyer(reg, {}, None)._autopay_verify(
            buy_assignment(reg), SNAP, 'S(085)', '무신사머니', '7140449'
        )


# ───── 접수 ─────
BRIEF = {
    'order_number': 'A1',
    'ready': True,
    'account': {'username': 'rnwhgowh', 'label': 'L'},
    'expected': {'net_cost': 44090},
    'refresh': {'cheaper': False, 'change': 0},
    'problems': [],
}


class _IntakeWave:
    def __init__(self, targets, refresh=None, error=None) -> None:
        self.targets, self.refresh, self.error, self.refreshed = targets, refresh or {}, error, []
        self.notes: list[tuple[str, str, str]] = []

    def autopay_status(self, order_no, kind, text):
        self.notes.append((order_no, kind, text))
        return {'ok': True}

    def autopay_queue(self, limit=20):
        if self.error:
            raise self.error
        return self.targets

    def autopay_refresh(self, order_no):
        self.refreshed.append(order_no)
        out = self.refresh[order_no]
        if isinstance(out, Exception):
            raise out
        return out


class _Slack:
    def __init__(self) -> None:
        self.tops: list[str] = []

    def post_new(self, text):
        self.tops.append(text)
        return f'ts{len(self.tops)}'

    def post_line(self, ts, text):
        return True


@pytest.fixture()
def intake_setup(tmp_path):
    q, slack = JobQueue(tmp_path / 'jobs.sqlite'), _Slack()

    def make(wave, **kw):
        return AutopayIntake(wave, q, slack.post_new, slack.post_line, **kw)

    return q, slack, make


def test_ready_orders_are_queued_with_the_autopay_options(intake_setup):
    q, slack, make = intake_setup
    wave = _IntakeWave(
        [{'order_number': 'A1'}, {'order_number': 'A2'}],
        {'A1': BRIEF, 'A2': {**BRIEF, 'order_number': 'A2'}},
    )
    report = make(wave).run_once()
    assert (report.seen, report.enqueued, report.not_ready) == (2, 2, 0)
    job = q.get('A1')
    assert job.requester == 'autopay' and job.state == 'queued' and job.thread_ts == 'ts1'
    assert job.options == {
        'autopay': '1',
        'autopay_username': 'rnwhgowh',
        'card': '무신사머니',
        'no_cross': '1',
    }
    assert slack.tops[0].startswith('자동결제 접수: A1')


def test_every_target_is_re_quoted_by_samba_before_it_is_queued(intake_setup):
    q, _, make = intake_setup
    wave = _IntakeWave(
        [{'order_number': 'A1'}],
        {
            'A1': {
                **BRIEF,
                'account': {'username': 'topminn12'},
                'refresh': {'cheaper': True, 'change': -790},
            }
        },
    )
    make(wave).run_once()
    assert wave.refreshed == ['A1'] and q.get('A1').options['autopay_username'] == 'topminn12'


def test_not_ready_orders_are_not_queued_and_the_reason_is_not_repeated_every_cycle(intake_setup):
    q, slack, make = intake_setup
    wave = _IntakeWave(
        [{'order_number': 'A1'}],
        {'A1': {**BRIEF, 'ready': False, 'problems': ['계정 비교가 덜 끝났습니다(11/12)']}},
    )
    intake = make(wave)
    assert intake.run_once().not_ready == 1 and intake.run_once().not_ready == 1
    assert q.get('A1') is None and len(slack.tops) == 1 and '11/12' in slack.tops[0]


def test_finished_or_stuck_jobs_are_never_revived_and_wave_errors_are_survived(intake_setup):
    q, _, make = intake_setup
    q.enqueue('A1', 'autopay', {}, thread_ts=None)
    q.finish(q.get('A1').id, 'needs_human', error='x')
    wave = _IntakeWave([{'order_number': 'A1'}], {'A1': BRIEF})
    report = make(wave).run_once()
    assert report.skipped_live == 1 and wave.refreshed == [] and q.get('A1').state == 'needs_human'
    assert make(_IntakeWave([], error=WaveError(FailReason.BRIDGE_DOWN, 'x'))).run_once().seen == 0
    refresh_error = _IntakeWave(
        [{'order_number': 'B1'}], {'B1': WaveError(FailReason.UNKNOWN, 'x')}
    )
    assert make(refresh_error).run_once().not_ready == 1 and q.get('B1') is None


def test_max_new_and_pause(intake_setup):
    _, _, make = intake_setup
    targets = [{'order_number': f'A{i}'} for i in range(5)]
    wave = _IntakeWave(targets, {f'A{i}': {**BRIEF, 'order_number': f'A{i}'} for i in range(5)})
    intake = make(wave, max_new=2)
    assert intake.run_once().enqueued == 2
    intake.pause()
    assert intake.run_once().enqueued == 0
    intake.resume()
    assert intake.run_once().enqueued == 2


def test_general_intake_leaves_musinsa_auto_pay_orders_to_the_autopay_intake(tmp_path):
    q = JobQueue(tmp_path / 'jobs.sqlite')
    reg = Registry.load(DEFAULT_ROOT)
    slack = _Slack()

    class W:
        def pending_orders(self, days=7, limit=100):
            now = datetime(2026, 10, 6, tzinfo=UTC)
            return [
                WaveOrder(
                    order_number='AP1',
                    source_site='MUSINSA',
                    product_name='x',
                    product_option='M',
                    action_tag='direct,auto_pay',
                    paid_at=now,
                ),
                WaveOrder(
                    order_number='N1',
                    source_site='MUSINSA',
                    product_name='x',
                    product_option='M',
                    paid_at=now - timedelta(minutes=1),
                ),
                WaveOrder(
                    order_number='C1',
                    source_site='29CM',
                    product_name='x',
                    product_option='M',
                    action_tag='auto_pay',
                    paid_at=now - timedelta(minutes=2),
                ),
            ]

    on = Intake(W(), q, reg, slack.post_new, slack.post_line, days=7, skip_autopay=True)
    on.run_once()
    assert q.get('AP1') is None and q.get('N1') is not None  # 자동결제 무신사만 건너뛴다
    assert q.get('C1') is not None  # 다른 소싱처는 그대로
    q2 = JobQueue(tmp_path / 'jobs2.sqlite')
    Intake(W(), q2, reg, slack.post_new, slack.post_line, days=7).run_once()
    assert q2.get('AP1') is not None  # 기본(꺼짐)은 예전과 같다


# ───── 감독자 그래프: 자동결제 구매 결과가 삼바 판정 없이 결제로 넘어가지 않는다 ─────
def test_supervisor_stops_before_payment_without_the_samba_verdict_and_skips_the_harness_margin_gate(
    reg,
):
    paid = []

    def make_buy(payload):
        return lambda a: AgentResult(status='ok', reason='b', payload=payload)

    def payer(a):
        paid.append(a.order.order_no)
        return AgentResult(
            status='ok',
            reason='p',
            payload={'source_order_no': '202610060000001', 'card': '무신사머니'},
        )

    base = {'autopay': '1'}
    for payload, expect_paid in (
        ({'card': '무신사머니', 'margin_pct': -99, 'autopay_verified': True}, True),
        ({'card': '무신사머니', 'margin_pct': 30}, False),
    ):
        paid.clear()
        agents = {
            'buyer.musinsa': make_buy(payload),
            'autopay_recorder': lambda a: AgentResult(status='ok', reason='r'),
            'autopay_verifier': lambda a: AgentResult(status='ok', reason='v'),
            'payer': payer,
        }
        graph = build_supervisor(reg, agents)
        out = graph.invoke(
            {
                'order': ORDER,
                'options': base,
                'dry_run': False,
                'results': {},
                'evidence': [],
                'attempts': {},
            }
        )
        assert bool(paid) is expect_paid, payload
        assert (out.get('outcome') == 'done') is expect_paid


def test_not_ready_orders_rest_for_the_cooldown_so_the_twelve_accounts_are_not_re_quoted_every_cycle(
    intake_setup,
):
    _, _, make = intake_setup
    clock = {'now': 1000.0}
    wave = _IntakeWave(
        [{'order_number': 'A1'}],
        {'A1': {**BRIEF, 'ready': False, 'problems': ['계정 비교가 덜 끝났습니다(11/12)']}},
    )
    intake = make(wave, cooldown_s=900, clock=lambda: clock['now'])
    intake.run_once()
    clock['now'] += 600
    assert intake.run_once().not_ready == 1 and wave.refreshed == [
        'A1'
    ]  # 쉬는 중 — 다시 비교하지 않는다
    clock['now'] += 301
    intake.run_once()
    assert wave.refreshed == ['A1', 'A1']  # 쿨다운이 지나면 다시 재비교
    wave.refresh['A1'] = BRIEF
    clock['now'] += 901
    assert intake.run_once().enqueued == 1


def test_a_refresh_error_also_rests(intake_setup):
    _, _, make = intake_setup
    clock = {'now': 0.0}
    wave = _IntakeWave([{'order_number': 'B1'}], {'B1': WaveError(FailReason.UNKNOWN, 'x')})
    intake = make(wave, cooldown_s=900, clock=lambda: clock['now'])
    intake.run_once()
    intake.run_once()
    assert wave.refreshed == ['B1']


# ───── 막혀도 끝이 아니다: 사람 손 없이 풀리는 결제 전 막힘은 쉬었다가 자동 재시도(2026-10-06) ─────
from datetime import UTC, datetime, timedelta  # noqa: E402


def _stuck(q, order_no, reason, state='needs_human'):
    q.enqueue(order_no, 'autopay', {'autopay': '1', 'autopay_username': 'old'}, thread_ts=None)
    q.finish(q.get(order_no).id, state, error=reason)


@pytest.mark.parametrize('reason', ['bridge_down', 'permission_denied'])
def test_a_pre_payment_block_is_retried_after_the_rest_with_the_fresh_samba_account(intake_setup, reason):
    q, slack, make = intake_setup
    _stuck(q, 'A1', reason)
    wave = _IntakeWave([{'order_number': 'A1'}], {'A1': {**BRIEF, 'account': {'username': 'topminn12'}}})
    later = datetime.now(UTC) + timedelta(minutes=11)
    report = make(wave, wall=lambda: later).run_once()
    job = q.get('A1')
    assert (report.enqueued, report.retried) == (1, 1) and wave.refreshed == ['A1']
    assert job.state == 'queued' and job.attempts == 1 and job.error is None
    assert job.options['autopay_username'] == 'topminn12'          # 재시도는 삼바가 다시 정한 계정으로
    assert any('자동결제 재시도 1/3' in t for t in slack.tops)


def test_a_block_is_not_retried_before_the_rest_is_over_and_stops_after_the_cap(intake_setup):
    q, _, make = intake_setup
    _stuck(q, 'A1', 'bridge_down')
    wave = _IntakeWave([{'order_number': 'A1'}], {'A1': BRIEF})
    assert make(wave).run_once().retried == 0 and q.get('A1').state == 'needs_human'   # 막힌 직후엔 쉰다
    later = datetime.now(UTC) + timedelta(minutes=11)
    intake = make(wave, wall=lambda: later)
    for expected_attempts in (1, 2, 3):
        assert intake.run_once().retried == 1
        assert q.get('A1').attempts == expected_attempts
        q.finish(q.get('A1').id, 'needs_human', error='bridge_down')
        later += timedelta(minutes=11)
        intake = make(wave, wall=lambda t=later: t)
    assert intake.run_once().retried == 0 and q.get('A1').state == 'needs_human'       # 3번 뒤엔 사람에게 남는다


@pytest.mark.parametrize('reason', ['margin', 'out_of_stock', 'verify_mismatch', 'pay_interrupted', 'unknown', 'duplicate', 'card_missing', 'captcha'])
def test_payment_time_or_decided_failures_are_never_revived_automatically(intake_setup, reason):
    q, _, make = intake_setup
    _stuck(q, 'A1', reason)
    wave = _IntakeWave([{'order_number': 'A1'}], {'A1': BRIEF})
    later = datetime.now(UTC) + timedelta(hours=5)
    report = make(wave, wall=lambda: later).run_once()
    assert report.retried == 0 and report.skipped_live == 1 and wave.refreshed == [] and q.get('A1').state == 'needs_human'


def test_an_approval_wait_and_a_running_job_are_never_retried(intake_setup):
    q, _, make = intake_setup
    q.enqueue('A1', 'autopay', {}, thread_ts=None)                                      # queued(진행 중)
    q.enqueue('A2', 'autopay', {}, thread_ts=None)
    q.finish(q.get('A2').id, 'needs_human', error=None)                                 # 승인 대기 등 사유 없는 사람 넘김
    wave = _IntakeWave([{'order_number': 'A1'}, {'order_number': 'A2'}], {'A1': BRIEF, 'A2': BRIEF})
    later = datetime.now(UTC) + timedelta(hours=5)
    assert make(wave, wall=lambda: later).run_once().retried == 0 and wave.refreshed == []


def test_a_retry_still_needs_samba_to_say_the_order_is_ready(intake_setup):
    q, _, make = intake_setup
    _stuck(q, 'A1', 'permission_denied')
    wave = _IntakeWave([{'order_number': 'A1'}], {'A1': {**BRIEF, 'ready': False, 'problems': ['계정 비교가 덜 끝났습니다(11/12)']}})
    later = datetime.now(UTC) + timedelta(minutes=11)
    report = make(wave, wall=lambda: later).run_once()
    assert report.retried == 0 and report.not_ready == 1 and q.get('A1').state == 'needs_human'


# ───── 사람이 알아야 할 이슈는 삼바 간단메모 밑 '자동결제' 칸에 적는다(2026-10-06) ─────
def test_not_ready_reasons_land_in_the_samba_cell_as_wait_or_action(intake_setup):
    q, _, make = intake_setup
    wave = _IntakeWave(
        [{'order_number': 'A1'}, {'order_number': 'A2'}],
        {
            'A1': {**BRIEF, 'ready': False, 'problems': ['계정 비교가 덜 끝났습니다(11/12)']},
            'A2': {**BRIEF, 'ready': False, 'problems': ['메모의 1순위 계정을 삼바 구매 계정에서 찾지 못했습니다']},
        },
    )
    make(wave).run_once()
    kinds = {n[0]: n[1] for n in wave.notes}
    assert kinds == {'A1': 'info', 'A2': 'action'}                       # 시간이 풀어 주는 것 / 사람이 고칠 것
    assert '11/12' in next(n[2] for n in wave.notes if n[0] == 'A1')


def test_a_refresh_failure_and_a_cell_write_failure_never_stop_the_intake(intake_setup):
    q, _, make = intake_setup

    class _Flaky(_IntakeWave):
        def autopay_status(self, order_no, kind, text):
            raise WaveError(FailReason.BRIDGE_DOWN, 'x')

    wave = _Flaky([{'order_number': 'A1'}, {'order_number': 'A2'}], {'A1': WaveError(FailReason.UNKNOWN, 'x'), 'A2': BRIEF})
    report = make(wave).run_once()
    assert report.not_ready == 1 and report.enqueued == 1 and q.get('A2').state == 'queued'


def test_queued_orders_clear_the_old_cell_line_and_retries_do_too(intake_setup):
    q, _, make = intake_setup
    wave = _IntakeWave([{'order_number': 'A1'}], {'A1': BRIEF})
    make(wave).run_once()
    assert ('A1', 'clear', '') in wave.notes


def test_a_finally_stuck_autopay_job_writes_its_reason_to_samba():
    from samba_agent.__main__ import _autopay_stop_note
    from samba_agent.queue.db import Job

    class _W:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str, str]] = []

        def autopay_status(self, order_no, kind, text):
            self.calls.append((order_no, kind, text))

    def job(options, attempts=0):
        return Job(1, 'A1', 'autopay', options, 'needs_human', None, None, None, None, attempts, None, '', '')

    wave = _W()
    note = _autopay_stop_note(wave)
    note(job({'autopay': '1'}), 'permission_denied', '로그인 실패(무신사_rnwhgowh): 페이지 응답 없음')
    note(job({'autopay': '1'}, attempts=3), 'permission_denied', '로그인 실패')
    note(job({'autopay': '1'}), 'margin', '마진 미달')
    note(job({}), 'margin', '자동결제 아닌 작업은 적지 않는다')
    assert [c[1] for c in wave.calls] == ['retry', 'action', 'action']
    assert '자동 재시도(1/3)' in wave.calls[0][2] and '10분' in wave.calls[0][2]
    assert 'margin' in wave.calls[2][2]


def test_the_worker_reports_a_final_stop_through_the_hook_and_survives_a_hook_failure(tmp_path):
    from samba_agent.queue.db import JobQueue
    from samba_agent.queue.worker import Worker

    q = JobQueue(tmp_path / 'j.sqlite')
    seen: list[tuple[str, str]] = []

    def hook(job, fail, reason):
        seen.append((fail, reason))
        raise RuntimeError('삼바 칸 쓰기 실패')

    class _D:
        queue = q
        stop_note = staticmethod(hook)

    worker = Worker.__new__(Worker)
    worker.d = _D()  # type: ignore[assignment]
    q.enqueue('A1', 'autopay', {'autopay': '1'}, thread_ts=None)
    job = q.get('A1')
    worker._stop_note(job, 'permission_denied', '로그인 실패')  # 훅이 던져도 예외가 새지 않는다
    assert seen == [('permission_denied', '로그인 실패')]
