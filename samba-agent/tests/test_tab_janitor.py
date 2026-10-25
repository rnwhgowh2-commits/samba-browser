"""작업이 연 탭 정리 — 다른 레인이 연 탭(lane 표시)은 닫지 않는다."""

import json
from types import SimpleNamespace

from samba_agent.queue.tabs import TabJanitor


class _Bridge:
    def __init__(self, tabs: list[dict[str, object]]) -> None:
        self.tabs = tabs
        self.closed: list[str] = []

    def call(self, name: str, **kw: object) -> SimpleNamespace:
        if name == 'list_tabs':
            return SimpleNamespace(result=json.dumps(self.tabs))
        if name == 'close_tab':
            self.closed.append(str(kw['id']))
            return SimpleNamespace(result='ok')
        raise AssertionError(name)


def test_다른_레인_탭은_닫지_않는다():
    # 실기 2026-09-27: 하네스 작업이 끝나며 사람이 fp 레인에서 진행하던 패션플러스 주문서를 닫았다
    bridge = _Bridge([{'id': 'old'}])
    janitor = TabJanitor(bridge)  # type: ignore[arg-type]
    before = janitor.snapshot()
    bridge.tabs = [{'id': 'old'}, {'id': 'mine'}, {'id': 'fp1', 'lane': 'fp'}, {'id': 'pop', 'lane': 'fp'}]
    assert janitor.close_new(before) == 1
    assert bridge.closed == ['mine']


def test_하네스가_다루는_소싱처_탭만_정리하고_다른_세션의_탭은_남긴다():
    # 실기 2026-10-06: 삼바 브라우저를 다른 세션이 같이 쓰는 중 롯데홈쇼핑 로그인 탭이 하네스 작업 시작 때 닫혔다
    bridge = _Bridge(
        [
            {'id': 'mine', 'url': 'https://www.musinsa.com/order/checkout'},
            {'id': 'other', 'url': 'https://www.lotteimall.com/member/login/forward.LCLoginMem.lotte'},
            {'id': 'home', 'url': 'https://samba-wave.example/orders'},
        ]
    )
    janitor = TabJanitor(bridge, scope_hosts=('musinsa.com', '29cm.co.kr'))  # type: ignore[arg-type]
    assert janitor.close_leftovers() == 1
    assert bridge.closed == ['mine']


def test_범위가_비어_있으면_예전처럼_남길_호스트만_빼고_닫는다():
    bridge = _Bridge([{'id': 'a', 'url': 'https://www.musinsa.com/x'}, {'id': 'b', 'url': 'https://www.naver.com/'}])
    assert TabJanitor(bridge).close_leftovers() == 1  # type: ignore[arg-type]
    assert bridge.closed == ['a']


def test_새로_생긴_탭_정리도_범위_밖은_닫지_않는다():
    bridge = _Bridge([{'id': 'old'}])
    janitor = TabJanitor(bridge, scope_hosts=('musinsa.com',))  # type: ignore[arg-type]
    before = janitor.snapshot()
    bridge.tabs = [
        {'id': 'old'},
        {'id': 'mine', 'url': 'https://www.musinsa.com/products/1'},
        {'id': 'theirs', 'url': 'https://www.lotteimall.com/'},
    ]
    assert janitor.close_new(before) == 1
    assert bridge.closed == ['mine']
