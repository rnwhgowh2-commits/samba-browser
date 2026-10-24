// 네트워크 기록(network_record)에서 비밀값이 도구 결과로 새지 않게 가리는 순수 함수 모음.
//
// 원칙: AI 도구는 비밀값(비밀번호·카드·토큰·쿠키)을 읽지 못한다(키마스터 설계). 요청·응답 기록도 같다 —
// 헤더 값·본문 값 중 비밀로 보이는 것은 '<masked>' 로 바꾸고, 로그인·결제·인증 계열 주소는 본문 자체를 싣지 않는다.
// 이름(헤더 이름·JSON 키)은 남긴다 — "어떤 헤더가 필요한가"를 판단하는 데 이름이면 충분하다.

export const MASKED = '<masked>'
export const OMITTED = '<omitted: sensitive endpoint>'

// 값을 가릴 헤더 이름
const SENSITIVE_HEADER_RE =
  /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf.*|x-xsrf.*)$|token|secret|session|api[-_]?key|passw|signature|credential/i

// 값을 가릴 본문 키 (JSON 키·폼 필드 이름)
const SENSITIVE_KEY_RE =
  /pass|pwd|secret|token|card[-_]?(no|num|number|pw|pwd|password|cvc|cvv|expir\w*)|cvc|cvv|otp|^pin|[-_]pin$|ssn|jumin|resident|credential|session|auth(?!or)|signature|apikey|api[-_]key|csrf|xsrf|account[-_]?(no|num)/i

// 본문을 아예 싣지 않을 주소 경로
const SENSITIVE_PATH_RE =
  /login|signin|sign-in|signup|sign-up|logout|oauth|\/auth(\/|$)|token|passw|pwd|otp|certif|pincert|keypad|cardreg|member\/join/i
// 읽기(GET) 조회가 아닌 결제·카드·주문 쓰기 요청의 본문
const SENSITIVE_WRITE_PATH_RE = /pay|payment|checkout|card|order/i

/** 헤더 값을 가린 사본. 이름은 그대로 둔다 */
export function redactHeaders(
  headers: Record<string, unknown> | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER_RE.test(name) ? MASKED : String(value).slice(0, 200)
  }
  return out
}

/**
 * 이 주소의 요청·응답 본문을 기록에 싣지 않을 것인가.
 * 로그인·인증 계열은 방식과 무관하게, 결제·카드·주문 계열은 읽기(GET)가 아닌 요청일 때 싣지 않는다
 */
export function isSensitiveEndpoint(url: string, method = 'GET'): boolean {
  try {
    const u = new URL(url)
    if (SENSITIVE_PATH_RE.test(u.pathname)) return true
    return method.toUpperCase() !== 'GET' && SENSITIVE_WRITE_PATH_RE.test(u.pathname)
  } catch {
    return false
  }
}

function maskValueDeep(value: unknown, depth: number): unknown {
  if (depth > 12) return MASKED
  if (Array.isArray(value)) return value.map((v) => maskValueDeep(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? MASKED : maskValueDeep(v, depth + 1)
    }
    return out
  }
  return value
}

// 코드·HTML 안에 박힌 `token: "…"` / `password='…'` 꼴을 가린다
const INLINE_SECRET_RE =
  /((?:pass(?:word|wd)?|pwd|secret|token|api[-_]?key|access[-_]?key|session[-_]?id|csrf[-_]?token)\\?["']?\s*[:=]\s*\\?["'])([^"'\s\\]{6,})(\\?["'])/gi

// 글자 속 쿼리 꼴(`?accessToken=…`, `&password=…`) 값
const INLINE_QUERY_RE =
  /([?&;][\w.-]*(?:token|passw\w*|pwd|secret|api[-_]?key|session[-_]?id|auth(?!or))[\w.-]*=)([^&"'\s<>]{3,})/gi

function maskInline(text: string): string {
  return text
    .replace(INLINE_SECRET_RE, (_m, a: string, _v: string, c: string) => `${a}${MASKED}${c}`)
    .replace(INLINE_QUERY_RE, (_m, a: string) => `${a}${MASKED}`)
}

/**
 * 본문 글자에서 비밀로 보이는 값을 가린 사본.
 * JSON 이면 키 이름으로, 폼(a=b&c=d)이면 필드 이름으로, 그 밖의 글자는 인라인 패턴으로 가린다.
 */
export function redactBody(text: string, contentType = ''): string {
  const ct = contentType.toLowerCase()
  const trimmed = text.trim()
  if (ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(maskValueDeep(JSON.parse(trimmed), 0))
    } catch {
      // JSON 이 아니면 아래 글자 처리로
    }
  }
  if (
    ct.includes('x-www-form-urlencoded') ||
    /^[^\s=&]+=[^\s]*(&[^\s=&]+=[^\s]*)*$/.test(trimmed)
  ) {
    try {
      const params = new URLSearchParams(trimmed)
      const parts: string[] = []
      for (const [k, v] of params.entries()) {
        parts.push(`${k}=${SENSITIVE_KEY_RE.test(k) ? MASKED : v}`)
      }
      if (parts.length > 0) return parts.join('&')
    } catch {
      // 아래로
    }
  }
  return maskInline(text)
}

/** 글자를 n 자로 자르고, 잘렸으면 원래 길이를 덧붙인다 */
export function clip(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n)}… [+${text.length - n} chars]`
}

/** 글자로 읽을 수 있는 응답인가 (본문을 받아 둘 대상) */
export function isTextualMime(mime: string | undefined): boolean {
  if (!mime) return false
  const m = mime.toLowerCase()
  return (
    m.startsWith('text/') ||
    m.includes('json') ||
    m.includes('xml') ||
    m.includes('javascript') ||
    m.includes('x-www-form-urlencoded')
  )
}

/** 주소 쿼리의 비밀 이름 값(token=… 등)을 가린 주소. 파싱이 안 되면 그대로 둔다 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    let changed = false
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEY_RE.test(k)) {
        u.searchParams.set(k, MASKED)
        changed = true
      }
    }
    return changed ? u.toString() : url
  } catch {
    return url
  }
}
