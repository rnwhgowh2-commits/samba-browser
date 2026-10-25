import { z } from 'zod'
import type { StoredSection } from './fields'

// 로컬 행 번호 대신 도메인·아이디로 연결해 다른 PC 동기화 뒤에도 같은 계정을 찾는다.
export const LOGIN_SOURCE_HOST = 'login.sourceHost'
export const LOGIN_SOURCE_USERNAME = 'login.sourceUsername'
export const LOGIN_METHOD = 'login.method'

export const siteAccountSchema = z
  .object({
    url: z.string().url(),
    siteName: z.string().trim().min(1).max(120),
    username: z.string().trim().min(1).max(254).optional(),
    label: z.string().trim().min(1).max(120).optional(),
    sourceHost: z.string().trim().min(1).max(254).optional(),
    sourceAccountLabel: z.string().trim().min(1).max(254).optional(),
    loginMethod: z.enum(['shared_password', 'naver']).optional()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      !!v.sourceHost !== !!v.sourceAccountLabel ||
      (!v.username && !v.sourceHost) ||
      (v.loginMethod && !v.sourceHost)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '아이디 또는 연결할 원본 사이트·계정 라벨이 필요합니다'
      })
    }
  })

export type SiteAccountInput = z.infer<typeof siteAccountSchema>

export function loginMethodOf(sections: StoredSection[]): 'naver' | 'shared_password' {
  return sections
    .flatMap((s) => s.fields)
    .some((f) => f.key === LOGIN_METHOD && f.kind !== 'secret' && f.value === 'naver')
    ? 'naver'
    : 'shared_password'
}

export function loginSourceOf(
  sections: StoredSection[]
): { host: string; username: string } | null {
  const fields = sections.flatMap((s) => s.fields)
  const read = (key: string): string | undefined => {
    const field = fields.find((f) => f.key === key)
    return field && field.kind !== 'secret' ? field.value : undefined
  }
  const host = read(LOGIN_SOURCE_HOST)
  const username = read(LOGIN_SOURCE_USERNAME)
  return host && username ? { host, username } : null
}
