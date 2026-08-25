import claudeLogo from '../../assets/claude-code.png'
import codexLogo from '../../assets/codex.png'
import grokLogo from '../../assets/grok.png'
import ompLogo from '../../assets/omp.png'
import openCodeDarkLogo from '../../assets/open-white.png'
import openCodeLightLogo from '../../assets/open-black.png'
import { iconMap } from '../../assets/icons'
import type { AgentType, Theme } from '../../lib/types'
import { isLightTheme } from '../../lib/themes'
export function ShellIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 5l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 11h5" strokeLinecap="round" />
    </svg>
  )
}

export function OmpIcon({ size = 16 }: { size?: number }) {
  return <img src={ompLogo} alt="" width={size} height={size} draggable={false} />
}


export function GrokIcon({ size = 16 }: { size?: number }) {
  return <img src={grokLogo} alt="" width={size} height={size} draggable={false} />
}

export function ClaudeIcon({ size = 16 }: { size?: number }) {
  return <img src={claudeLogo} alt="" width={size} height={size} draggable={false} />
}

export function CodexIcon({ size = 16 }: { size?: number }) {
  return <img src={codexLogo} alt="" width={size} height={size} draggable={false} />
}

export function OpenCodeIcon({ size = 16, theme }: { size?: number; theme?: Theme }) {
  return (
    <img
      src={theme && isLightTheme(theme) ? openCodeLightLogo : openCodeDarkLogo}
      alt=""
      width={size}
      height={size}
      draggable={false}
    />
  )
}

export function VSCodeIcon({ size = 14 }: { size?: number }) {
  return <img src={iconMap.vscode} alt="" width={size} height={size} draggable={false} />
}

export function AgentIcon({
  type,
  size = 16,
  theme,
}: {
  type: AgentType
  size?: number
  theme: Theme
}) {
  if (type === 'omp') return <OmpIcon size={size} />
  if (type === 'grok') return <GrokIcon size={size} />
  if (type === 'claude') return <ClaudeIcon size={size} />
  if (type === 'codex') return <CodexIcon size={size} />
  if (type === 'opencode') return <OpenCodeIcon size={size} theme={theme} />
  return <ShellIcon size={size} />
}
