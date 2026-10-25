import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ToolContext } from './tools'
import { agentTargetOf } from './target'
import { normalizeHost } from '../../shared/host'
import { checkVaultGate, sameRegistrableDomain } from '../vault/access-gate'

export const ACCOUNT_TOOL_NAMES = ['register_site_account']
const accountSchema = {
  siteName: z.string().trim().min(1).max(120),
  username: z.string().trim().min(1).max(254).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  sourceHost: z.string().trim().min(1).max(254).optional(),
  sourceAccountLabel: z.string().trim().min(1).max(254).optional(),
  loginMethod: z.enum(['shared_password', 'naver']).optional()
}

type Run = (
  label: string,
  fn: () => Promise<string>
) => Promise<{
  content: [{ type: 'text'; text: string }]
}>

/** 기존 login/fill_secret 경로가 읽는 실제 키마스터 계정을 만든다. 값은 도구 인자로 받지 않는다. */
export function createAccountTools(
  ctx: ToolContext,
  run: Run
): SdkMcpToolDefinition<typeof accountSchema>[] {
  return [
    tool(
      'register_site_account',
      'Register a KeyMaster account for the CURRENT site without changing its signed-in session. ' +
        'Pass username for a session-only account, or sourceHost AND the exact sourceAccountLabel to reuse ' +
        'an existing saved login for this site. Use loginMethod="naver" for Naver SSO with the existing profile session; ' +
        'shared_password is only for explicitly requested shared credentials. Naver SSO never fills the Naver password into the site. ' +
        'Passwords are never accepted or returned. Does not register a new membership on the website. ' +
        'Existing login credentials and access policies are preserved. Purchases/claims still need their own user request.',
      accountSchema,
      (args) =>
        run('사이트 계정 등록·연결', async () => {
          if (ctx.mode === 'read_only') return 'refused: read-only mode'
          const tab = agentTargetOf(ctx.tabs)
          if (!tab) return 'refused: no active tab'
          const url = tab.view.webContents.getURL()
          const blocked = checkVaultGate({
            url,
            excludedHosts: ctx.vaultExcludedHosts ?? [],
            policy: ctx.vaultAccessPolicy ?? 'while_unlocked'
          })
          if (blocked) return `refused: ${blocked}`
          const vault = ctx.vault
          if (!vault || vault.state() === 'uninitialized') return 'refused: set up KeyMaster first'
          if (vault.state() !== 'unlocked' && ctx.vaultAccessPolicy === 'always') {
            await vault.ensureUnlockedByDevice()
          }
          if (vault.state() !== 'unlocked') return 'locked: ask the user to unlock 키마스터'
          if (
            ctx.mode === 'guard' &&
            !(await ctx.confirm(
              `${args.siteName} 계정 ${args.sourceHost ? `로그인 연결: ${args.sourceHost} (${args.sourceAccountLabel}) →` : '등록:'} ${normalizeHost(url)}`,
              'danger'
            ))
          )
            return 'denied by user'
          // 확인 대기 중 다른 도메인으로 이동했으면 그 사이트에는 연결을 만들지 않는다.
          const currentUrl = tab.view.webContents.getURL()
          if (!sameRegistrableDomain(normalizeHost(url), normalizeHost(currentUrl))) {
            return 'refused: page moved to another site'
          }
          const movedGate = checkVaultGate({
            url: currentUrl,
            excludedHosts: ctx.vaultExcludedHosts ?? [],
            policy: ctx.vaultAccessPolicy ?? 'while_unlocked'
          })
          if (movedGate) return `refused: ${movedGate}`
          try {
            const account = vault.registerSiteAccount({ ...args, url: currentUrl })
            return JSON.stringify({
              ok: true,
              host: account.host,
              label: account.label,
              types: account.itemTypes,
              linked: !!args.sourceHost,
              loginMethod: args.sourceHost ? (args.loginMethod ?? 'shared_password') : null,
              sessionPreserved: true,
              access: account.agentAccess
            })
          } catch {
            // 원본 아이디·비밀번호·검증 입력을 오류 본문에 싣지 않는다.
            return 'refused: account registration failed; check source selection, existing login and KeyMaster access'
          }
        })
    )
  ]
}
