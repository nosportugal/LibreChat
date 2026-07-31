import type { TxMetadata } from './transactions';

jest.mock('@librechat/data-schemas', () => ({ CANCEL_RATE: 1.15 }));

import { prepareCostSpend } from './transactions';

const base: TxMetadata = {
  user: 'user-1',
  model: 'gpt-4o',
  context: 'message',
  conversationId: 'conv-1',
  messageId: 'msg-1',
};

describe('prepareCostSpend', () => {
  it('produces a single direct-value transaction: tokenValue = -(costUSD * 1e6)', () => {
    const entry = prepareCostSpend(
      { ...base, costUSD: 0.00123, balance: { enabled: true } },
      { promptTokens: 100, completionTokens: 50 },
    );
    expect(entry).not.toBeNull();
    expect(entry!.tokenValue).toBe(-1230);
    expect(entry!.doc.tokenValue).toBe(-1230);
    expect(entry!.doc.rate).toBe(0);
    // token counts preserved for display
    expect(entry!.doc.inputTokens).toBe(100);
    expect(entry!.doc.rawAmount).toBe(-50);
    expect(entry!.balance).toEqual({ enabled: true });
  });

  it('handles zero cost', () => {
    const entry = prepareCostSpend(
      { ...base, costUSD: 0 },
      { promptTokens: 10, completionTokens: 5 },
    );
    expect(entry!.tokenValue).toBe(-0);
  });

  it('returns null for invalid cost (trust boundary)', () => {
    expect(
      prepareCostSpend({ ...base, costUSD: NaN }, { promptTokens: 1, completionTokens: 1 }),
    ).toBeNull();
    expect(
      prepareCostSpend({ ...base, costUSD: -0.5 }, { promptTokens: 1, completionTokens: 1 }),
    ).toBeNull();
  });

  it('returns null when transactions are disabled', () => {
    const entry = prepareCostSpend(
      { ...base, costUSD: 0.01, transactions: { enabled: false } },
      { promptTokens: 1, completionTokens: 1 },
    );
    expect(entry).toBeNull();
  });

  it('clamps negative token counts to zero for display fields', () => {
    const entry = prepareCostSpend(
      { ...base, costUSD: 0.01 },
      { promptTokens: -5, completionTokens: -3 },
    );
    expect(entry!.doc.inputTokens).toBe(0);
    expect(entry!.doc.rawAmount).toBe(-0);
  });
});
