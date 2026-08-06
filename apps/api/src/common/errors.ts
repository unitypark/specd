import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Refusal when a project has spent its monthly cap (§12). 429 rather than 402
 * so callers already handling backoff treat it as "not now" — the ePD pattern
 * this is lifted from used the same code.
 */
export class SpendCapExceeded extends HttpException {
  constructor(spentCents: number, capCents: number) {
    super(
      {
        error: 'spend_cap_exceeded',
        message: `Monthly agent spend cap reached: €${(spentCents / 100).toFixed(2)} of €${(
          capCents / 100
        ).toFixed(2)}. Raise the cap in project settings, or wait for the next month.`,
        spentCents,
        capCents,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * The gate, enforced server-side so the CLI cannot route around it (D13).
 * `specd spec pull` on a draft lands here.
 */
export class SpecNotApproved extends HttpException {
  constructor(status: string) {
    super(
      {
        error: 'spec_not_approved',
        message:
          `This spec is "${status}". Only approved specs can be pulled — a named ` +
          'human has to stamp it first. That is the whole point of the gate.',
        status,
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class AgentsPaused extends HttpException {
  constructor() {
    super(
      {
        error: 'agents_paused',
        message: 'Agent runs are paused for this project (kill switch is on).',
      },
      HttpStatus.CONFLICT,
    );
  }
}

export class AiNotConfigured extends HttpException {
  constructor(detail: string) {
    super(
      {
        error: 'ai_not_configured',
        message: detail,
      },
      HttpStatus.PRECONDITION_FAILED,
    );
  }
}
