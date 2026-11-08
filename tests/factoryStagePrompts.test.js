/**
 * Repo-owned stage prompt documents (card 6ae9676f557d52cce856d1a4;
 * docs/factory-prompts/, docs/factory.md "Stage prompts (repo-owned)").
 *
 * Pins the artifacts the spawn machinery seeds subagents with:
 *   - inventory: docs/factory-prompts/ contains exactly the expected docs,
 *     and STAGE_PROMPT_FILES (the code source of truth for stage → file)
 *     matches them;
 *   - tag coverage: each stage doc carries its board-contract verdict tags,
 *     every stage-verdict tag in docs/factory.md's Stages table is covered
 *     by exactly one doc (a contract addition without doc coverage fails),
 *     and no doc invents a tag outside the Board contract set;
 *   - structure: the shared preamble markers every spawned agent needs
 *     (comment CLI, exactly-one/first-token verdict, card-move ban, [ASK]);
 *   - stage-specific rules: the [IMPL] evidence rule, the reviewer's
 *     automatic-finding + mergeability rules + risk-tier review depth /
 *     intent check (matching scripts/lib/factory-risk.js when merged), the
 *     security severity rule + checklist pointer, the qa full-suite
 *     procedure;
 *   - review guide: docs/review-guide/ contains exactly the index + the
 *     three area docs, each area doc carries the four required fields
 *     (failure mode, must-check behaviors, paths to skip, evidence
 *     format) plus the nit cap, the README owns the path → area map and
 *     the spot-check ritual, every mapped path resolves to real repo
 *     paths (stale-path guard), and reviewer.md + docs/factory.md stay
 *     pointed at the guide (three-way sync).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { STAGE_PROMPT_FILES, buildRunPrompt } from '../scripts/factory-daemon.js';
import { buildResumePrompt } from '../scripts/lib/factory-comment-resume.js';
import { loadRegistry, worktreeFor } from '../scripts/lib/factory-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_DIR = path.join(ROOT, 'docs', 'factory-prompts');
const readRepo = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const STAGES = ['planner', 'implementer', 'reviewer', 'security-reviewer', 'qa'];

/** Verdict tags each stage doc must carry (board contract). */
const STAGE_TAGS = {
  planner: ['[PLAN]'],
  implementer: ['[IMPL]'],
  reviewer: ['[REVIEW:APPROVE]', '[REVIEW:CHANGES]'],
  'security-reviewer': ['[SEC:PASS]', '[SEC:FINDINGS]'],
  qa: ['[QA:PASS]', '[QA:FAIL]'],
};

/** docs/factory.md Stages-table first-cell name → stage key. */
const TABLE_STAGE = {
  Plan: 'planner',
  Implement: 'implementer',
  Review: 'reviewer',
  Security: 'security-reviewer',
  'Test/QA': 'qa',
};

const docOf = (stage) => readRepo(STAGE_PROMPT_FILES[stage]);
const factoryDoc = readRepo('docs/factory.md');

/** A stage doc's `## Verdict` section — what it claims as its verdict. */
function verdictSection(doc) {
  const start = doc.indexOf('## Verdict');
  if (start === -1) return '';
  const next = doc.indexOf('\n## ', start + 1);
  return next === -1 ? doc.slice(start) : doc.slice(start, next);
}

describe('docs/factory-prompts inventory', () => {
  it('contains exactly README + the five stage docs', () => {
    expect(readdirSync(PROMPT_DIR).sort()).toEqual(
      ['README.md', ...STAGES.map((s) => `${s}.md`)].sort(),
    );
  });

  it('STAGE_PROMPT_FILES maps every stage to an existing repo-owned doc', () => {
    expect(Object.keys(STAGE_PROMPT_FILES).sort()).toEqual([...STAGES].sort());
    for (const stage of STAGES) {
      const rel = STAGE_PROMPT_FILES[stage];
      expect(rel).toBe(`docs/factory-prompts/${stage}.md`);
      expect(existsSync(path.join(ROOT, rel))).toBe(true);
    }
  });

  it('docs/factory.md points at every stage doc', () => {
    for (const stage of STAGES) {
      expect(factoryDoc).toContain(STAGE_PROMPT_FILES[stage]);
    }
    expect(factoryDoc).toContain('Stage prompts (repo-owned)');
    expect(factoryDoc).toContain('override your harness role defaults');
  });

  it('scheduler loop keeps the order qa → RISK GATE → PRE-MERGE GUARD → merge → push, with no merge/push line between the gates (card 6ae9676d0ee4189387157881)', () => {
    const qa = factoryDoc.indexOf('move → QA;');
    const risk = factoryDoc.indexOf('RISK GATE: node scripts/factory.js approve');
    const guard = factoryDoc.indexOf('PRE-MERGE GUARD (');
    const merge = factoryDoc.indexOf('git merge --ff-only factory/<id> → master; run npm test   ←');
    expect(qa).toBeGreaterThanOrEqual(0);
    expect(risk).toBeGreaterThan(qa);
    expect(guard).toBeGreaterThan(risk);
    expect(merge).toBeGreaterThan(guard);
    // a stray "git merge/test/push" line must never sit between the gates —
    // merging before the guard is the exact bug a docs re-union reintroduces
    const between = factoryDoc.slice(risk, guard);
    expect(between).not.toMatch(/git merge --ff-only|git push origin master/);
  });
});

describe('verdict-tag coverage against the board contract', () => {
  it('each stage doc carries its verdict tags', () => {
    for (const stage of STAGES) {
      const doc = docOf(stage);
      for (const tag of STAGE_TAGS[stage]) {
        expect(doc).toContain(tag);
      }
    }
  });

  it('every stage-verdict tag in the Stages table is covered by exactly one doc', () => {
    const stagesSection = factoryDoc.slice(
      factoryDoc.indexOf('## Stages\n'),
      factoryDoc.indexOf('## Stage prompts (repo-owned)'),
    );
    expect(stagesSection.length).toBeGreaterThan(0);
    const rows = stagesSection
      .split('\n')
      .filter((l) => /^\|\s*(Plan|Implement|Review|Security|Test\/QA)\s*\|/.test(l));
    expect(rows.length).toBe(STAGES.length);
    const tagRe = /\[(?:PLAN|IMPL|REVIEW:[A-Z]+|SEC:[A-Z]+|QA:[A-Z]+)\]/g;
    for (const row of rows) {
      const cells = row.split('|');
      const stage = TABLE_STAGE[cells[1].trim()];
      const outputTags = [...new Set(cells[4].match(tagRe) ?? [])];
      expect(outputTags.length).toBeGreaterThan(0);
      for (const tag of outputTags) {
        // Exactly one doc may OWN a tag (claim it in its `## Verdict`
        // section) — other docs may cross-reference it (e.g. Review
        // citing the [IMPL] evidence rule), but a table tag with no
        // owning stage doc — or two — fails the contract pin.
        const owner = STAGES.find((s) => STAGE_TAGS[s].includes(tag));
        expect(owner).toBeDefined();
        const owning = STAGES.filter((s) => verdictSection(docOf(s)).includes(tag));
        expect(owning).toEqual([owner]);
      }
    }
  });

  it('no stage doc references a tag outside the board contract set', () => {
    const bc = factoryDoc.indexOf('first token is a tag:');
    expect(bc).toBeGreaterThan(-1);
    const seg = factoryDoc.slice(bc, factoryDoc.indexOf('[RESUME]', bc) + '[RESUME]'.length);
    const contract = new Set(seg.match(/\[[A-Z][A-Z:]*(?::[A-Z]+)?\]/g));
    expect(contract.size).toBeGreaterThan(8);
    for (const stage of STAGES) {
      for (const tag of docOf(stage).match(/\[[A-Z][A-Z]*(?::[A-Z]+)?\]/g) ?? []) {
        expect(contract.has(tag)).toBe(true);
      }
    }
  });

  it('blocking-checks gate tags are contract members owned by no stage', () => {
    // [CHECK:PASS]/[CHECK:FAIL] are posted by the daemon's blocking-checks
    // gate (docs/factory.md "Independent blocking checks") — scheduler
    // bookkeeping, same class as [DEPLOY]/[RESUME]. They must sit inside
    // the contract slice (BEFORE the first [RESUME] — stage docs reference
    // them, so the pin above demands membership), yet no stage doc may own
    // or claim them in its `## Verdict` section.
    const bc = factoryDoc.indexOf('first token is a tag:');
    const seg = factoryDoc.slice(bc, factoryDoc.indexOf('[RESUME]', bc) + '[RESUME]'.length);
    const contract = new Set(seg.match(/\[[A-Z][A-Z:]*(?::[A-Z]+)?\]/g));
    for (const tag of ['[CHECK:PASS]', '[CHECK:FAIL]']) {
      expect(contract.has(tag)).toBe(true);
      for (const stage of STAGES) {
        expect(STAGE_TAGS[stage].includes(tag)).toBe(false);
        expect(verdictSection(docOf(stage))).not.toContain(tag);
      }
    }
  });
});

describe('stage docs are self-sufficient (shared preamble markers)', () => {
  for (const stage of STAGES) {
    it(`${stage}: spawn agent can act from the doc alone`, () => {
      const doc = docOf(stage);
      expect(doc).toContain('node scripts/factory.js comment');
      expect(doc).toMatch(/exactly one comment/i);
      expect(doc).toMatch(/first token/i);
      expect(doc).toMatch(/never move the card/i);
      expect(doc).toContain('[ASK]');
      expect(doc).toMatch(/overrides your harness role\s+defaults/i);
      expect(doc).toContain('node scripts/factory.js read');
    });
  }
});

describe('stage-specific rules pinned in the docs', () => {
  it('implementer doc carries the [IMPL] evidence rule', () => {
    const doc = docOf('implementer');
    expect(doc).toMatch(/exact commands/i);
    expect(doc).toMatch(/observed output/i);
    expect(doc).toMatch(/exit codes/i);
    expect(doc).toMatch(/would \*?not\*? catch/i);
    expect(doc).toMatch(/screenshot/i);
  });

  it('reviewer doc ties missing [IMPL] evidence and mergeability to the verdict', () => {
    const doc = docOf('reviewer');
    expect(doc).toMatch(/missing `?\[IMPL\]`? evidence is an automatic `?\[REVIEW:CHANGES\]`?/i);
    expect(doc).toMatch(/only mergeable code\s+may pass review/i);
    expect(doc).toContain('factory.js mergeable');
    expect(doc).toMatch(/read-only/i);
  });

  it('reviewer doc scales review depth to the risk tiers and carries the intent check', () => {
    const doc = docOf('reviewer');
    expect(doc).toContain('factory.js risk');
    expect(doc).toContain('quick pass');
    expect(doc).toContain('full pass');
    expect(doc).toMatch(/\blow\b/);
    expect(doc).toMatch(/\bmedium\b/);
    expect(doc).toMatch(/\bhigh\b/);
    expect(doc).toContain('config/'); // always-human anchor
    expect(doc).toContain('500'); // churn threshold
    expect(doc).toContain('25'); // file-count threshold
    expect(doc).toMatch(/does this diff solve the problem the card states/i);
  });

  it('reviewer depth tiers match the approval classifier when present', async () => {
    const doc = docOf('reviewer');
    const lib = path.join(ROOT, 'scripts', 'lib', 'factory-risk.js');
    if (!existsSync(lib)) {
      // The classifier card is not on this tree yet: pin the brief's
      // inline fallback rules so the reviewer classifies identically by
      // hand — the same tier names and thresholds. Plain branch, never
      // skip: the suite pins something on both trees.
      expect(doc).toMatch(/\blow\b/);
      expect(doc).toMatch(/\bmedium\b/);
      expect(doc).toMatch(/\bhigh\b/);
      expect(doc).toContain('500');
      expect(doc).toContain('25');
      return;
    }
    const mod = await import(pathToFileURL(lib).href);
    const classifyDiff = mod.classifyDiff ?? mod.default?.classifyDiff;
    expect(typeof classifyDiff).toBe('function');
    const start = doc.indexOf('## Review depth scales with risk');
    expect(start).toBeGreaterThan(-1);
    const next = doc.indexOf('\n## ', start + 1);
    const depthSection = next === -1 ? doc.slice(start) : doc.slice(start, next);
    const samples = [
      ['docs-only', [{ path: 'docs/a.md', additions: 10, deletions: 3 }], 'low'],
      ['additive-only', [{ path: 'src/a.js', additions: 10, deletions: 0 }], 'low'],
      ['always-human path', [{ path: 'config/app.json', additions: 1, deletions: 1 }], 'high'],
      ['churn ≥ 500', [{ path: 'src/a.js', additions: 300, deletions: 220 }], 'high'],
      ['mixed code edit', [{ path: 'src/a.js', additions: 10, deletions: 4 }], 'medium'],
    ];
    for (const [name, files, expected] of samples) {
      const { tier } = classifyDiff(files);
      expect({ name, tier }).toEqual({ name, tier: expected });
      // Every tier the classifier returns must be named in the brief's
      // depth section, so classifier-tunable drift trips this suite.
      expect(depthSection).toContain(tier);
    }
  });

  it('reviewer doc points at the per-area ground-truth docs', () => {
    const doc = docOf('reviewer');
    expect(doc).toContain('docs/review-guide/README.md');
    expect(doc).toMatch(/must-check behaviors/i);
    expect(doc).toMatch(/paths to skip/i);
    expect(doc).toMatch(/file:line/i);
    // The verdict comment must name applied docs — the spot-check handle.
    expect(doc).toMatch(/area ground-truth docs applied|no area doc matched/i);
  });

  it('security-reviewer doc carries the severity rule + checklist pointer', () => {
    const doc = docOf('security-reviewer');
    expect(doc).toContain('HIGH/MEDIUM');
    expect(doc).toMatch(/LOW\/INFO/i);
    expect(doc).toContain('docs/security-review.md');
    expect(doc).toMatch(/read it first/i);
    expect(doc).toMatch(/file:line/);
  });

  it('qa doc names the full suite, lint, and acceptance walkthrough', () => {
    const doc = docOf('qa');
    expect(doc).toContain('npm test');
    expect(doc).toMatch(/lint/i);
    expect(doc).toMatch(/acceptance/i);
    expect(doc).toMatch(/\[REVIEW:APPROVE\]/);
    expect(doc).toMatch(/\[SEC:PASS\]/);
  });

  it('per-finding disposition rule pinned across the docs', () => {
    // Board contract owns the canonical rule.
    expect(factoryDoc).toMatch(/Findings disposition/i);
    expect(factoryDoc).toMatch(/not-a-bug/i);
    // Implementer owes the enumeration for every finding tag (decision D1)
    // and exempts [VERIFY:FAIL].
    const impl = docOf('implementer');
    for (const tag of ['[REVIEW:CHANGES]', '[SEC:FINDINGS]', '[QA:FAIL]']) {
      expect(impl).toContain(tag);
    }
    expect(impl).toMatch(/Findings disposition/i);
    expect(impl).toMatch(/fixed [—-]/);
    expect(impl).toMatch(/not-a-bug/i);
    expect(impl).toMatch(/\[VERIFY:FAIL\]/);
    // Reviewer checks the enumeration before judging the diff (decision D2).
    const rev = docOf('reviewer');
    expect(rev).toMatch(/Findings disposition/i);
    expect(rev).toMatch(/before\s+judging the diff/i);
    expect(rev).toMatch(/automatic `?\[REVIEW:CHANGES\]`?/i);
    // Security doc cross-references the rule for its own findings (D1+D2).
    expect(docOf('security-reviewer')).toMatch(/Findings\s+disposition/i);
    expect(docOf('security-reviewer')).toMatch(/not-a-bug/i);
  });
});

describe('docs/review-guide (per-area review ground truth)', () => {
  const GUIDE_DIR = path.join(ROOT, 'docs', 'review-guide');
  const AREA_DOCS = [
    'memory-embeddings.md',
    'deploy-ssh.md',
    'trello-discord-io.md',
  ];

  it('contains exactly the README + the three area docs', () => {
    expect(readdirSync(GUIDE_DIR).sort()).toEqual(
      ['README.md', ...AREA_DOCS].sort(),
    );
  });

  it('each area doc carries the four required fields + the nit cap', () => {
    for (const area of AREA_DOCS) {
      const doc = readRepo(`docs/review-guide/${area}`);
      expect(doc).toMatch(/## Failure mode/i);
      expect(doc).toMatch(/## Must-check behaviors/i);
      expect(doc).toMatch(/## Paths to skip/i);
      expect(doc).toMatch(/## Evidence format/i);
      expect(doc).toMatch(/## Nit cap/i);
    }
  });

  it('README owns the path → area map and the spot-check ritual', () => {
    const readme = readRepo('docs/review-guide/README.md');
    for (const area of AREA_DOCS) expect(readme).toContain(area);
    // Representative anchor prefixes per area — the mapping table's rows.
    expect(readme).toContain('service/ai/memory/');
    expect(readme).toContain('scripts/deploy.js');
    expect(readme).toContain('scripts/lib/trello.js');
    expect(readme).toContain('## Spot-check log');
    expect(readme).toMatch(/cadence/i);
  });

  it('every map path resolves to real repo paths (stale-path guard)', () => {
    const readme = readRepo('docs/review-guide/README.md');
    const rows = readme
      .split('\n')
      .filter((l) => /^\|\s*(memory\/embeddings|deploy\/SSH|Trello\/Discord I\/O)\s*\|/.test(l));
    expect(rows.length).toBe(AREA_DOCS.length);
    const files = [];
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else files.push(r);
      }
    };
    // The map rows describe code in EVERY repo the factory manages — review
    // targets live in sibling checkouts (registry repoDir,
    // docs/factory-migration.md §4.1). Resolve mapped paths against all
    // registered repo trees, not just this one (extraction FM-1 adaptation).
    walk(ROOT, '');
    let registry = null;
    try {
      registry = loadRegistry({ env: {} });
    } catch {
      /* registry unreadable → ROOT-only walk; stale paths fail below */
    }
    if (registry) {
      for (const r of Object.values(registry.repos)) {
        if (existsSync(r.repoDir) && path.resolve(r.repoDir) !== ROOT) walk(r.repoDir, '');
      }
    }
    for (const row of rows) {
      const entries = row
        .split('|')[3]
        .split(',')
        .map((s) => s.replace(/`/g, '').trim())
        .filter(Boolean);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        // `*` = glob (must match ≥1 real file); `/`-ending = directory
        // (≥1 file under it); otherwise prefix/exact path (≥1 file starts
        // with it — covers exact files and prefixes like deploy-).
        const matched = entry.includes('*')
          ? files.some(
              (f) =>
                new RegExp(
                  '^' +
                    entry.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
                    '$',
                ).test(f),
            )
          : files.some((f) => f.startsWith(entry));
        if (!matched) throw new Error(`stale map path: "${entry}" matches no repo file`);
      }
    }
  });

  it('docs/factory.md points at the guide (three-way doc sync)', () => {
    expect(factoryDoc).toContain('docs/review-guide/');
    expect(factoryDoc).toMatch(/spot-check/i);
  });
});

describe('scheduler prompts seed the stage docs', () => {
  it('buildRunPrompt points every stage subagent at its file', () => {
    const prompt = buildRunPrompt({ id: 'abc', name: 'X' });
    for (const stage of STAGES) {
      expect(prompt).toContain(STAGE_PROMPT_FILES[stage]);
    }
    expect(prompt).toContain('override your harness role defaults');
  });
});

// FM-2 (§4.3): the REPO CONTEXT block — the run/resume prompts must carry the
// exact repo paths, bootstrap recipe, and deploy command lines from
// config/factory-repos.json, so the stage agents never guess where the repo,
// worktree, or deploy runner lives. Pinned here alongside the stage seeds.
describe('REPO CONTEXT block (FM-2, docs/factory-migration.md §4.3)', () => {
  const registry = loadRegistry({ env: {} });
  const card = { id: '6ae4b88307df4b89018e8d7f', name: 'Context canary' };
  const HEAD = 'REPO CONTEXT (repo registry: config/factory-repos.json';
  const FACTORY_CLI =
    '- All factory CLI invocations (node scripts/factory.js …) run from the FACTORY repo checkout, not the card worktree.';

  it('the default run prompt carries the registry defaultRepo context', () => {
    const p = buildRunPrompt(card);
    expect(p).toContain(HEAD);
    expect(p).toContain(`- repo: ${registry.defaultRepo}`);
    expect(p).toContain(FACTORY_CLI);
  });

  it('a routed repo entry carries repoDir, baseBranch, worktree path, worktree-add line, bootstrap recipe, and deploy driver lines', () => {
    const repo = registry.repos['discord-bot'];
    const wt = worktreeFor(repo, card.id);
    const p = buildRunPrompt(card, { repo });
    expect(p).toContain(HEAD);
    expect(p).toContain('- repo: discord-bot');
    expect(p).toContain(`- repoDir: ${repo.repoDir}`);
    expect(p).toContain('- baseBranch: master');
    expect(p).toContain(`- worktree: ${wt}`);
    expect(p).toContain(`git -C ${repo.repoDir} worktree add ${wt} -b factory/${card.id} origin/master`);
    for (const step of repo.worktreeBootstrap) {
      expect(p).toContain(step.replaceAll('<wt>', wt).replaceAll('<factoryRoot>', ROOT));
    }
    expect(p).not.toContain('<wt>'); // placeholders fully substituted
    expect(p).toContain('- deploy driver: docker-ssh');
    expect(p).toContain('node scripts/deploy.js build master');
    expect(p).toContain('node scripts/deploy.js rollback');
    expect(p).toContain('node scripts/verify-deploy.js');
  });

  it('the resume prompt carries the same block and mandates the registry worktree', () => {
    const repo = registry.repos['discord-bot'];
    const wt = worktreeFor(repo, card.id);
    const p = buildResumePrompt(card, { stage: 'Implement', crash: 1, repo });
    expect(p).toContain(HEAD);
    expect(p).toContain('- repo: discord-bot');
    expect(p).toContain(`git worktree at ${wt}`);
    expect(p).toContain('- deploy driver: docker-ssh');
    expect(p).toContain(FACTORY_CLI);
  });

  it('repo-less callers keep the pre-FM-2 prompt shape (byte-identical legacy worktree path)', () => {
    const p = buildResumePrompt(card, { stage: 'Implement', crash: 1 });
    expect(p).not.toContain(HEAD);
    expect(p).toContain(`git worktree at ../discord-bot-factory-wt/${card.id}`);
  });
});
