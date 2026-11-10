// The board's checker (ADR-0018), as it runs in its own public GitHub
// repository on the free plan: GitHub Actions starts it every few minutes
// (check.yml). It takes what is waiting on the board, re-runs each record on
// the check module of the build that played it, fetched from the site and
// kept in builds/ (so a build stays checkable once the site has moved on),
// files each board's AUTOPILOT REFERENCE once a build, and sends the verdicts
// signed with the job's own GitHub token, which the board checks
// (server/board/oidc.js). Nothing here is secret, and it needs no packages.
//
// One record never stops the rest: a build the site does not serve, a module
// that does not load and a record that does not re-run are each that record's
// own verdict, and the checker goes on to the next.
//
//   BOARD  the board service (the Worker's address by default)
//   SITE   the site whose builds it fetches (criticalresponse.rabbithouse.art)

import { access, mkdir, rm, writeFile } from 'node:fs/promises';

const BOARD = process.env.BOARD ?? 'https://critical-response-board.mrgedune.workers.dev';
const SITE = process.env.SITE ?? 'https://criticalresponse.rabbithouse.art';
const AUDIENCE = 'critical-response-board';
const HOLD = 24 * 3600000; // ms a record waits for its build to be served before it is refused
const builds = new URL('./builds/', import.meta.url);

// fetch, once more after a pause if the connection drops (a re-run takes
// long enough for an idle one to be closed under it).
async function ask(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    await new Promise((done) => setTimeout(done, 2000));
    return fetch(url, init);
  }
}

const isBuild = (build) => typeof build === 'string' && /^[0-9a-z]{1,32}$/.test(build);
const loaded = new Map();

// Whether what the site answered is a module. A site with no page for a
// missing file answers with its title page and 200, so the status alone
// cannot say: a module is served as JavaScript and does not open with a tag.
const isModule = (answer, bytes) =>
  answer.ok &&
  /javascript/i.test(answer.headers.get('content-type') ?? '') &&
  !bytes.subarray(0, 256).toString('latin1').trimStart().startsWith('<');

// A build's check module: kept, or fetched from the site and kept. Null for
// one the site does not serve, and for one that does not load (one fetched
// this run is then not kept, so the next run asks the site again).
async function moduleFor(build) {
  if (!isBuild(build)) return null;
  if (loaded.has(build)) return loaded.get(build);
  const file = new URL(`${build}.mjs`, builds);
  let mod = null;
  let fetched = false;
  try {
    try {
      await access(file);
    } catch {
      fetched = true;
      const answer = await ask(`${SITE}/check/${build}.mjs`);
      const bytes = Buffer.from(await answer.arrayBuffer());
      if (!isModule(answer, bytes)) throw new Error('the site does not serve it');
      await mkdir(builds, { recursive: true });
      await writeFile(file, bytes);
      console.log(`kept build ${build}`);
    }
    mod = await import(file.href);
    if (typeof mod.check !== 'function') throw new Error('it has no check');
  } catch (error) {
    console.log(`build ${build}: ${error.message}`);
    mod = null;
    // Only what this run fetched: a module kept from an earlier run stays.
    if (fetched) await rm(file, { force: true });
  }
  loaded.set(build, mod);
  return mod;
}

// The job's token from GitHub, for the board.
async function signed() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const word = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !word) throw new Error('no id-token: the workflow needs `id-token: write`');
  const answer = await ask(`${url}&audience=${AUDIENCE}`, {
    headers: { Authorization: `bearer ${word}` },
  });
  if (!answer.ok) throw new Error(`id-token: ${answer.status}`);
  return (await answer.json()).value;
}

// Verdicts sent to the board. One that does not arrive is said and left: the
// record is still waiting, and the next run sends it again.
async function send(body) {
  try {
    const answer = await ask(`${BOARD}/verdicts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await signed()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log(`verdicts: ${answer.status} ${await answer.text()}`);
  } catch (error) {
    console.log(`verdicts not sent: ${error.message}`);
  }
}

// The site's own build, kept as soon as it is served.
try {
  const current = await (await ask(`${SITE}/check/current.json`)).json();
  await moduleFor(current.build);
} catch (error) {
  console.log(`current build: ${error.message}`);
}

// What is waiting. No board yet (before the service is deployed) or no answer
// ends the run quietly: GitHub mails the owner about every scheduled run that
// fails, and the next run in five minutes asks again.
let pending = [];
try {
  const answer = await ask(`${BOARD}/pending`);
  if (!answer.ok) throw new Error(`${answer.status}`);
  ({ pending = [] } = await answer.json());
} catch (error) {
  console.log(`no answer from the board: ${error.message}`);
}
console.log(`${pending.length} waiting`);
const referenced = new Set();
for (const { id, build, board, at } of pending) {
  const mod = await moduleFor(build);
  if (!mod) {
    if (Date.now() - at > HOLD)
      await send({ verdicts: [{ id, verdict: { ok: false, why: 'THAT BUILD IS NOT SERVED' } }] });
    continue;
  }
  let record;
  try {
    record = await ask(`${BOARD}/entries/${id}/record`);
  } catch (error) {
    console.log(`${id}: no answer from the board: ${error.message}`);
    continue;
  }
  if (!record.ok) continue;
  const started = performance.now();
  let verdict;
  try {
    verdict = await mod.check(new Uint8Array(await record.arrayBuffer()), { now: at });
    if (!verdict || typeof verdict !== 'object') throw new Error('no verdict');
  } catch (error) {
    console.log(`${id}: the check failed: ${error.message}`);
    verdict = { ok: false, why: 'THE RECORD DOES NOT RE-RUN' };
  }
  console.log(
    `${id} ${board}: ${verdict.ok ? `LOGGED ${Number(verdict.time).toFixed(2)}` : `REFUSED ${verdict.why}`}` +
      ` (${((performance.now() - started) / 1000).toFixed(1)} s)`,
  );
  const references = [];
  if (verdict.ok && !referenced.has(`${board} ${build}`)) {
    referenced.add(`${board} ${build}`);
    // The board's reference is a courtesy: a run is never held up for it.
    try {
      const list = await (await ask(`${BOARD}/boards/${board}`)).json();
      if (!(build in (list.references ?? {})))
        references.push({ board, build, ...mod.reference(board) });
    } catch (error) {
      console.log(`${board}: no reference filed: ${error.message}`);
    }
  }
  await send({ verdicts: [{ id, verdict }], references });
}
