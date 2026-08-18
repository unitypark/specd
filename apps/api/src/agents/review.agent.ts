import { Injectable } from '@nestjs/common';
import { STATION_EFFORT, type Effort, type ModelId, type SpecView } from '@specd/shared';
import { ClaudeCodeProvider } from './claude-code.provider.js';

/**
 * Station 05b — Review.
 *
 * specd ran the repository's verify command and stopped. That answers "do the
 * tests pass", which is the question a test suite already answers; it does not
 * answer "is this the change we approved, and is it any good". The build agent
 * cannot answer that about its own work in the same turn it does the work —
 * so this is a separate pass, over the diff, with the spec beside it.
 *
 * Advisory by construction. It reports into the pull request a human is about
 * to read; it does not fail a build. Making a finding refusable is a per-project
 * policy decision (2.4), the same line citation drift sits on — an unrelated
 * opinion should never be able to stop an approved spec from shipping.
 */
@Injectable()
export class ReviewAgent {
  constructor(private readonly claudeCode: ClaudeCodeProvider) {}

  /** The prompt half, rendered without side effects so a runner can execute it. */
  prepare(spec: SpecView): { system: string; schema: Record<string, unknown>; brief: string } {
    return { system: REVIEW_SYSTEM_PROMPT, schema: REVIEW_SCHEMA, brief: specBrief(spec) };
  }

  async run(input: {
    spec: SpecView;
    model: ModelId;
    effort?: Effort;
    workspaceDir: string;
    diff: string;
  }): Promise<ReviewFindings> {
    const { system, schema, brief } = this.prepare(input.spec);

    const result = await this.claudeCode.review<ReviewFindings>({
      model: input.model,
      effort: input.effort ?? STATION_EFFORT.review,
      workspaceDir: input.workspaceDir,
      system,
      schema,
      user: reviewPrompt(brief, input.diff),
    });

    return result.parsed ?? { findings: [], verdict: 'unreviewed' };
  }
}

export interface ReviewFinding {
  /** `path:line`, so it is clickable where the PR renders it. */
  where: string;
  severity: 'blocking' | 'consider' | 'nit';
  what: string;
  /** Which acceptance criterion or design claim it bears on, if any. */
  against?: string;
}

export interface ReviewFindings {
  findings: ReviewFinding[];
  verdict: 'clean' | 'findings' | 'unreviewed';
  /** One line a reviewer reads before the list. */
  summary?: string;
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['clean', 'findings'],
      description: '"clean" only if you would approve this as written.',
    },
    summary: {
      type: 'string',
      description:
        'One sentence: what this change does, and whether it does what the spec approved. No preamble.',
    },
    findings: {
      type: 'array',
      description:
        'What a reviewer should look at. Empty is a valid and useful answer — do not pad it.',
      items: {
        type: 'object',
        properties: {
          where: { type: 'string', description: 'path:line, from the diff.' },
          severity: {
            type: 'string',
            enum: ['blocking', 'consider', 'nit'],
            description:
              'blocking: wrong, unsafe, or not what the spec approved. consider: a real improvement. nit: style.',
          },
          what: {
            type: 'string',
            description:
              'The problem and why it is one, in one or two sentences. Name the failing input where you can.',
          },
          against: {
            type: 'string',
            description:
              'The acceptance criterion or design claim this bears on, quoted. Omit if none.',
          },
        },
        required: ['where', 'severity', 'what'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
} as const;

const REVIEW_SYSTEM_PROMPT = `You are reviewing a diff an agent wrote from an approved spec, for a
human who is about to decide whether to merge it.

You have read-only tools. Use them: the diff is what changed, not what the code
around it does, and a finding you could not have made without opening the file
is worth more than one you could have made from the diff alone.

The question is not "is this clever". It is:

1. Does it do what the spec approved — no less, and no more? Work the spec did
   not ask for is a finding, not a bonus.
2. Is it correct? Name the input or state that breaks it. A concern you cannot
   turn into a failing case is a nit at most.
3. Does it match this codebase? Read the surrounding code and the knowledge
   base before calling something unidiomatic.

Rules:

- Report what you find, at the severity you actually believe. Do not filter for
  importance — a human ranks these, and a finding you suppressed because it
  seemed minor is one they never got to weigh.
- An empty findings list is a real answer. Do not manufacture one to look
  thorough; padding here is what makes the whole section ignorable.
- Every finding names a location from the diff and, where it bears on one, the
  acceptance criterion or design claim it is measured against.
- You are advisory. You are not blocking the merge, and you are not rewriting
  the code — say what is wrong, not what you would have written instead.`;

function specBrief(spec: SpecView): string {
  const criteria = spec.content.requirements
    .flatMap((r) => r.criteria)
    .map((c) => `- ${c.keyword} ${c.trigger} THE SYSTEM SHALL ${c.response}`)
    .join('\n');

  const design = spec.content.design
    .map((d) => (d.citation ? `- ${d.text}  [per ${d.citation}]` : `- ${d.text}  [UNVERIFIED]`))
    .join('\n');

  return `Spec ${spec.ticketKey} v${spec.version} — ${spec.title}
Approved by ${spec.approvedBy ?? 'unknown'}

=== ACCEPTANCE CRITERIA (what the change must satisfy) ===
${criteria || '(none recorded)'}

=== DESIGN (what was agreed; a deviation is a finding) ===
${design || '(none recorded)'}`;
}

function reviewPrompt(brief: string, diff: string): string {
  return `${brief}

=== THE DIFF ===
${diff}

Review it. Open the files you need.`;
}
