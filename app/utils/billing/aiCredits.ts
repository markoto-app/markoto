// Client shape of AI credit top-ups, mirrors
// `server/utils/billing/aiCreditBudget.ts#creditBalanceView`.

export interface CreditBalanceView {
  usableUsd: number
  usedThisMonthUsd: number
  grants: Array<{ pack: string, amountUsd: number, remainingUsd: number, refundedUsd: number, expiresAt: string, createdAt: string }>
}
