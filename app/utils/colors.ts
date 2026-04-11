const palette = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#a855f7',
  '#6366f1', '#10b981', '#e11d48', '#0ea5e9', '#84cc16'
]

export function pickColor(): string {
  return palette[Math.floor(Math.random() * palette.length)]
}
