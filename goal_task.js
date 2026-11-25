/*
 * Goal-setting fishing task (PsychoJS). Parameters: goal_task_config.js. Schedule: schedules_fmri/ (Simulation/schedule.py).
 *
 *   Session  : welcome -> instruction slides -> practice (3 days) -> comprehension quiz -> "Your fishing trip begins!"
 *              -> main task -> end
 *   Main task: 9 fishing spots (megablocks, one background each); a spot ends after the day during which the session
 *              reaches its `ends_at_trial` (megablocks.csv). When the fuel (session trials) runs out, the game stops
 *              and the net is lost.
 *   Day      : (block) trial 1 (free choice) -> goal setting -> trials, with a "keep fishing or leave?" probe after
 *              trial 3, 5, 7... -> end of the day (goal reached / left / 20-catch limit) -> end-of-day ratings.
 *   Trial    : choice screen -> catch (the net grows; it is emptied first if the creature changed) -> "Fish again!".
 *
 * URL options (testing):  ?participant=XYZ  skips the participant dialog;  ?auto=1  plays automatically;
 *   ?fast=1  shortens all durations;  ?speed=2  twice as fast;  ?megablock=N  skips the instructions, the practice
 *   and the quiz and starts at spot N;  ?quiz=1  skips the instructions and the practice (starts at the quiz);
 *   ?envorder=3,1,2,...  imposes the order of the backgrounds.
 *
 * Each screen is an async function that the session `await`s, so the order of the functions is the order of the task.
 */

import { core, util, visual } from './lib/psychojs-2024.1.0.js';
import { CONFIG } from './goal_task_config.js';

const { PsychoJS } = core;
const { Scheduler } = util;

const URL_PARAMS = new URLSearchParams(window.location.search);
const AUTO = URL_PARAMS.get('auto') === '1';
const SPEED_UP = Number(URL_PARAMS.get('speed')) > 0 ? Number(URL_PARAMS.get('speed')) : null;  // ?speed=2: twice as fast
const FAST = SPEED_UP ? false : URL_PARAMS.has('fast') ? URL_PARAMS.get('fast') === '1' : AUTO;  // auto mode is fast unless fast=0
const SPEED = SPEED_UP ? 1 / SPEED_UP : FAST ? 0.02 : 1;  // multiplies every duration (and the 1 s per auto decision)

const expName = 'goal_task';
const expInfo = { participant: URL_PARAMS.get('participant') || '' };

// ======================================================================================
// PsychoJS set-up
// ======================================================================================

const psychoJS = new PsychoJS({ debug: false });
window.psychoJS = psychoJS;  // for checking in the browser console
psychoJS.openWindow({
  fullscr: !AUTO,
  color: new util.Color([-0.24, -0.01, 0.18]),
  units: 'norm',
  waitBlanking: true,
});

const flowScheduler = new Scheduler(psychoJS);
const cancelScheduler = new Scheduler(psychoJS);
if (expInfo.participant) {
  psychoJS.schedule(flowScheduler);
} else {
  psychoJS.schedule(psychoJS.gui.DlgFromDict({ dictionary: expInfo, title: 'Fishing game' }));
  psychoJS.scheduleCondition(() => psychoJS.gui.dialogComponent.button === 'OK', flowScheduler, cancelScheduler);
}

// The whole task runs in `runSession`; this scheduler task only advances it one screen refresh at a time.
let frameWaiters = [];
let sessionStatus = 'running';
flowScheduler.add(() => {
  expInfo.date = util.MonotonicClock.getDateStr();
  expInfo.expName = expName;
  psychoJS.experiment.dataFileName = `data/${expInfo.participant}_${expName}_${expInfo.date}`;
  runSession().then(
    () => { sessionStatus = 'finished'; },
    (error) => { console.error(error); sessionStatus = 'error'; psychoJS.quit({ message: `Error: ${error}`, isCompleted: false }); },
  );
  return Scheduler.Event.NEXT;
});
flowScheduler.add(() => {
  if (psychoJS.eventManager.getKeys({ keyList: ['escape'] }).length > 0) {
    sessionStatus = 'escaped';
    psychoJS.quit({ message: 'The task was stopped (Escape).', isCompleted: false });
    return Scheduler.Event.QUIT;
  }
  const waiters = frameWaiters;
  frameWaiters = [];
  waiters.forEach((resolve) => resolve());
  return sessionStatus === 'running' ? Scheduler.Event.FLIP_REPEAT : Scheduler.Event.NEXT;
});
cancelScheduler.add(() => { psychoJS.quit({ message: 'Cancelled.', isCompleted: false }); return Scheduler.Event.QUIT; });

// ---- images (all downloaded before the task starts) ---------------------------------

const IMAGES = {
  plainSea: 'images/sea_plain.png',   // welcome, text and rating screens
  net: 'images/fishing_net.png',
  bag: 'images/money_bag.png',
  fuel: 'images/fuel_pump.png',       // petrol pump icon (tools/make_fuel_icon.py)
  merchant: 'images/merchant_boat.png',   // buys the catch when a goal is reached (tools/make_merchant_boat.py)
  ripple: 'images/ripple.png',        // soft ring on the water where the net lands (tools/make_ripple.py)
  ...CONFIG.optionImages,
};
const backgroundFile = (environment) => `${CONFIG.environmentFolder}/${environment.background}`;
// Instruction slides (exported from images/instructions/instructions.pptx): all but the last before the practice.
const slidePath = (k) => `images/instructions/instructions_${String(k).padStart(2, '0')}.jpg`;
const INSTRUCTION_SLIDES = Array.from({ length: CONFIG.instructionSlides - 1 }, (_, k) => slidePath(k));
const START_SLIDE = slidePath(CONFIG.instructionSlides - 1);   // "Your fishing trip begins!"
const IMAGE_FILES = [...new Set([...INSTRUCTION_SLIDES, START_SLIDE, ...Object.values(IMAGES), ...CONFIG.quiz.map((q) => q.image),
  ...[...CONFIG.environments, CONFIG.practiceEnvironment].map(backgroundFile)])];
psychoJS.start({ expName, expInfo, resources: IMAGE_FILES.map((path) => ({ name: path, path })) });

// ======================================================================================
// Small helpers: waiting, drawing, clicking, data
// ======================================================================================

const now = () => performance.now() / 1000;
const nextFrame = () => new Promise((resolve) => frameWaiters.push(resolve));

async function wait(seconds) {
  const end = now() + seconds * SPEED;
  do { await nextFrame(); } while (now() < end);
}

const WHITE = new util.Color('white');
const GAIN_COLOUR = new util.Color([-0.2, 0.85, -0.2]);   // green "+ N" coins
let mouse;
let shown = [];  // stimuli currently on screen
let backgroundStim = null;  // background image on screen
const backgroundStims = {};  // one background image per file, created once and reused

function show(...stims) {
  for (const stim of stims) { stim.setAutoDraw(true); shown.push(stim); }
}

/**
 * Removes a stimulus from the screen and frees its memory (thousands are created in a session).
 * setAutoDraw(false) must come first: release() alone leaves the stimulus in the window's draw list.
 */
function destroy(stim) {
  stim.setAutoDraw(false);
  stim.release();
}

/** Removes some stimuli from the screen (the others stay). */
function hide(stims) {
  for (const stim of stims) {
    destroy(stim);
    const i = shown.indexOf(stim);
    if (i >= 0) shown.splice(i, 1);
  }
}

function clearScreen() {
  for (const stim of shown) destroy(stim);
  shown = [];
  if (backgroundStim) backgroundStim.setAutoDraw(false);  // the large background images are kept and reused
}

/** Full-screen background image (drawn first, so that everything else is on top). */
function drawBackgroundImage(file) {
  if (!backgroundStims[file]) backgroundStims[file] = makeImage(file, [0, 0], [2, 2]);
  backgroundStim = backgroundStims[file];
  backgroundStim.setAutoDraw(true);
}

// Typography of the instruction slides: white sans-serif (Helvetica / Arial) with a soft dark drop shadow.
const TEXT_FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
class SlideText extends visual.TextStim {
  _getTextStyle() {
    const style = super._getTextStyle();
    Object.assign(style, {
      dropShadow: true, dropShadowColor: '#000000', dropShadowAlpha: 0.45,
      dropShadowBlur: 4, dropShadowDistance: 2, dropShadowAngle: Math.PI / 3,
    });
    return style;
  }
}

function makeText(text, pos, height = 0.06, wrapWidth = 1.6, color = WHITE) {
  return new SlideText({
    win: psychoJS.window, text, font: TEXT_FONT, pos, height, wrapWidth, color, units: 'norm',
  });
}

function makeImage(image, pos, size) {
  return new visual.ImageStim({ win: psychoJS.window, image, pos, size, units: 'norm', interpolate: true });
}

/** A filled bar starting at x = `left` (bars grow to the right). */
function makeBar(left, y, length, height, fill, opacity = 1) {
  const width = Math.max(length, 0.0005);
  return new visual.Rect({
    win: psychoJS.window, units: 'norm', pos: [left + width / 2, y], width, height,
    fillColor: new util.Color(fill), lineColor: new util.Color(fill), lineWidth: 0, opacity,
  });
}

/** Dark transparent panel (coins and fuel, end of the day). */
function makePanel(pos, width, height, opacity) {
  return new visual.Rect({
    win: psychoJS.window, units: 'norm', pos, width, height,
    fillColor: new util.Color('black'), lineColor: new util.Color('black'), lineWidth: 0, opacity,
  });
}

/** Button of the task: white rectangle with a black label. */
function makeWhiteButton(label, pos, width = 0.45, height = 0.1) {
  return {
    rect: new visual.Rect({
      win: psychoJS.window, units: 'norm', pos, width, height, fillColor: WHITE,
      lineColor: new util.Color('black'), lineWidth: 1, opacity: 0.85,
    }),
    text: makeText(label, pos, 0.06, 1, new util.Color('black')),
  };
}

function showButton(button) { show(button.rect, button.text); }

/**
 * Waits until one of `targets` (rectangles) is clicked; returns { index, rt }.
 * A click counts when the button goes down, so a button already held when the screen appears is ignored.
 * `autoChoice` gives the index chosen in auto mode.
 */
async function waitForClick(targets, autoChoice = () => 0) {
  const start = now();
  if (AUTO) { await wait(FAST ? 0 : 1); return { index: autoChoice(), rt: now() - start }; }
  let wasPressed = mouse.getPressed()[0] === 1;
  while (true) {
    await nextFrame();
    const pressed = mouse.getPressed()[0] === 1;
    if (pressed && !wasPressed) {
      const index = targets.findIndex((target) => target.contains(mouse));
      if (index >= 0) return { index, rt: now() - start };
    }
    wasPressed = pressed;
  }
}

/** Waits for a click anywhere on the screen (a button already held when the screen appears is ignored). */
async function waitForAnyClick() {
  const start = now();
  if (AUTO) { await wait(FAST ? 0 : 1); return now() - start; }
  let wasPressed = mouse.getPressed()[0] === 1;
  while (true) {
    await nextFrame();
    const pressed = mouse.getPressed()[0] === 1;
    if (pressed && !wasPressed) return now() - start;
    wasPressed = pressed;
  }
}

/** Text on the plain sea and one button. */
async function messageScreen(text, buttonLabel = 'Continue') {
  clearScreen();
  drawBackgroundImage(IMAGES.plainSea);
  show(makeText(text, [0, 0.15], 0.07));
  const button = makeWhiteButton(buttonLabel, [0, -0.5], 0.35);
  showButton(button);
  await waitForClick([button.rect]);
  clearScreen();
}

// ---- data: one row per event (trial, goal, probe, day end, ratings) --------------------

const rows = [];
window.taskData = rows;  // visible in the browser console for checking

function logEvent(event, fields) {
  const row = { participant: expInfo.participant, event, time: Number(now().toFixed(3)), ...fields };
  for (const [key, value] of Object.entries(row)) psychoJS.experiment.addData(key, value);
  psychoJS.experiment.nextEntry();
  rows.push(row);
}

// ======================================================================================
// Schedule
// ======================================================================================

async function loadCsv(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`cannot load ${path}`);
  const [header, ...lines] = (await response.text()).trim().split(/\r?\n/);
  const keys = header.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    const row = {};
    keys.forEach((key, i) => { const n = Number(cells[i]); row[key] = cells[i] !== '' && !Number.isNaN(n) ? n : cells[i]; });
    return row;
  });
}

/** Returns the megablocks in order, each with its blocks in order and each block with its trial rows. */
async function loadSchedule() {
  const dir = CONFIG.scheduleDir;
  const megablocks = await loadCsv(`${dir}/megablocks.csv`);
  const index = await loadCsv(`${dir}/block_index.csv`);
  const trials = await Promise.all(index.map((entry) => loadCsv(`${dir}/${entry.block_file}`)));
  index.forEach((entry, i) => { entry.trials = trials[i]; });
  return megablocks.map((mb) => ({
    ...mb,
    blocks: index.filter((b) => b.megablock === mb.megablock).sort((a, b) => a.block_in_megablock - b.block_in_megablock),
  }));
}

/** Integer drawn from the participant id (the same id always gives the same number). */
function participantHash() {
  let hash = 0;
  for (const ch of String(expInfo.participant)) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
  return hash;
}

/**
 * Chooses which background (CONFIG.environments) each megablock shows, so that the backgrounds are not tied to
 * the trends of the schedule (fMRI: images differ in contrast and detail). With CONFIG.randomEnvironmentOrder, the
 * order is a random permutation drawn from the participant id (the same id always gives the same order, e.g. after
 * a restart); otherwise the schedule order is used. With CONFIG.oneOfEachGroupPerRun, each run shows one background
 * of each `group` (similar backgrounds never in the same run). Testing: ?envorder=3,1,2,... imposes an order.
 * Each megablock gets its `environmentConfig` (entry of CONFIG.environments); the order is saved in the data.
 */
function assignBackgrounds(schedule) {
  const n = CONFIG.environments.length;
  let order = Array.from({ length: n }, (_, i) => i + 1);
  const imposed = URL_PARAMS.get('envorder');
  if (imposed) {
    order = imposed.split(',').map(Number);
  } else if (CONFIG.randomEnvironmentOrder) {
    let seed = participantHash();                   // seeded generator (mulberry32) from the participant id
    const random = () => {
      seed = (seed + 0x6D2B79F5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const shuffle = (list) => {                     // Fisher-Yates shuffle
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    };
    if (CONFIG.oneOfEachGroupPerRun) {
      // each run shows one background of each group (similar landscapes never in the same run), in random order
      const groups = [...new Set(CONFIG.environments.map((environment) => environment.group))];
      const runs = [...new Set(schedule.map((megablock) => megablock.run))];
      const pools = groups.map((group) => shuffle(CONFIG.environments
        .map((environment, k) => (environment.group === group ? k + 1 : null)).filter((k) => k !== null)));
      runs.forEach((run, r) => {
        const megablocks = schedule.filter((megablock) => megablock.run === run);
        if (megablocks.length !== groups.length || pools.some((pool) => pool.length !== runs.length)) {
          throw new Error('oneOfEachGroupPerRun needs as many groups as megablocks per run, and as many backgrounds per group as runs');
        }
        shuffle([...groups.keys()]).forEach((g, i) => { order[megablocks[i].environment - 1] = pools[g][r]; });
      });
    } else {
      shuffle(order);
    }
  }
  if (order.length !== n || new Set(order).size !== n || order.some((k) => !(k >= 1 && k <= n))) {
    throw new Error(`invalid environment order: ${order}`);
  }
  for (const megablock of schedule) megablock.environmentConfig = CONFIG.environments[order[megablock.environment - 1] - 1];
  logEvent('environment_order', {
    environment_order: order.join(' '),
    backgrounds: order.map((k) => CONFIG.environments[k - 1].name).join(' | '),
  });
}

/** Waits until PsychoJS has downloaded the images (it downloads them in the background). */
async function imagesDownloaded() {
  const ready = (path) => { try { psychoJS.serverManager.getResource(path, true); return true; } catch (e) { return false; } };
  while (!IMAGE_FILES.every(ready)) await nextFrame();
}

// ======================================================================================
// SESSION
// ======================================================================================

const state = {
  phase: 'main',   // 'practice' or 'main' (saved in every data row of a day)
  trialsDone: 0,   // trials played in the session (the fuel gauge shows the trials left)
  coins: 0,
  blockCount: 0,   // days started in the session
};
const remainingTrials = () => CONFIG.totalTrials - state.trialsDone;

async function runSession() {
  mouse = new core.Mouse({ win: psychoJS.window });
  show(makeText('Loading...', [0, 0]));
  const schedule = await loadSchedule();
  const practiceDays = await Promise.all(CONFIG.practiceDays.map((file) => loadCsv(`${CONFIG.scheduleDir}/${file}`)));
  assignBackgrounds(schedule);
  await imagesDownloaded();
  clearScreen();

  await welcomeScreen();
  if (!URL_PARAMS.has('megablock')) {   // testing: ?megablock=N skips the instructions, the practice and the quiz
    if (!URL_PARAMS.has('quiz')) {      // testing: ?quiz=1 starts at the quiz
      for (const slide of INSTRUCTION_SLIDES) await slideScreen(slide);
      await runPractice(practiceDays);
    }
    await runQuiz();
    await slideScreen(START_SLIDE);
  }

  const outcome = await runMainTask(schedule);
  await endScreen(outcome);
}

/** First screen: the plain sea and a welcome message; a click anywhere starts the game. */
async function welcomeScreen() {
  clearScreen();
  drawBackgroundImage(IMAGES.plainSea);
  show(makeText('Welcome to the study', [0, 0.2], 0.12),
    makeText('Click anywhere to start the fishing game', [0, -0.1], 0.07));
  const rt = await waitForAnyClick();
  logEvent('welcome', { rt: Number(rt.toFixed(3)) });
  clearScreen();
}

/** Instruction slide (full-screen image) with a Next button at the bottom right (the slides leave this corner free). */
async function slideScreen(file) {
  clearScreen();
  show(makeImage(file, [0, 0], [2, 2]));
  const next = makeWhiteButton('Next', [0.82, -0.94], 0.22, 0.08);
  showButton(next);
  const { rt } = await waitForClick([next.rect]);
  logEvent('instruction_slide', { slide: file, rt: Number(rt.toFixed(3)) });
  clearScreen();
}

/**
 * Practice trip: CONFIG.practiceDays days at the practice spot (stable values), played like the main task (goal
 * setting, probes) but without the end-of-day ratings. The practice has its own fuel and coins: the main task starts
 * with a full tank, 0 coins and day 1. Data rows of the practice have phase = 'practice'.
 */
async function runPractice(days) {
  const saved = { ...state };
  state.phase = 'practice';
  const spot = { megablock: 0, environment: 0, trend: 0, environmentConfig: CONFIG.practiceEnvironment };
  await newEnvironmentScreen(spot);
  for (const [k, trials] of days.entries()) {
    await runBlock(spot, { block_in_megablock: k + 1, block_file: CONFIG.practiceDays[k], trials });
  }
  Object.assign(state, saved);
  logEvent('practice_end', {});
  await messageScreen('End of the practice.\n\nThe coins of the practice do not count:\nyour trip starts with 0 coins and a full tank.');
}

// ======================================================================================
// COMPREHENSION QUIZ (after the practice), built like the quiz of the previous task: each question shows an
// illustration (top right), the question (left) and three answers (A, B, C); a Next button appears once an answer is
// chosen. If any answer is wrong, the quiz starts again (at most CONFIG.quizMaxAttempts attempts).
// ======================================================================================

async function runQuiz() {
  await messageScreen('Before starting your fishing trip,\nplease answer a few questions about the game.', 'Start');
  for (let attempt = 1; attempt <= CONFIG.quizMaxAttempts; attempt++) {
    let allCorrect = true;
    for (const question of CONFIG.quiz) allCorrect = (await quizQuestion(question, attempt)) && allCorrect;
    logEvent('quiz_result', { attempt, passed: allCorrect });
    if (allCorrect) {
      await messageScreen('Well done, all your answers are correct!');
      return;
    }
    if (attempt < CONFIG.quizMaxAttempts) {
      await messageScreen('Sorry, you did not answer all the questions correctly.\nPlease read them carefully and try again.');
    }
  }
}

/** One quiz question; returns true if the answer is correct. */
async function quizQuestion(question, attempt) {
  clearScreen();
  drawBackgroundImage(IMAGES.plainSea);
  show(new visual.Rect({   // white frame around the illustration
    win: psychoJS.window, units: 'norm', pos: [0.45, 0.45], width: 1.02, height: 1.02,
    fillColor: WHITE, lineColor: WHITE, lineWidth: 0,
  }), makeImage(question.image, [0.45, 0.45], [1, 1]),
  makeText(question.question, [-0.55, 0.45], 0.08, 0.85));
  const boxes = question.answers.map((answer, k) => {
    const pos = [0, -0.26 - 0.235 * k];
    const box = new visual.Rect({
      win: psychoJS.window, units: 'norm', pos, width: 1.84, height: 0.205,
      fillColor: new util.Color('black'), lineColor: WHITE, lineWidth: 2, opacity: 0.4,
    });
    show(box, makeText(`${'ABC'[k]}. ${answer}`, pos, 0.07, 1.76));
    return box;
  });
  const start = now();
  let chosen = null;
  let next = null;
  while (true) {
    const targets = next ? [...boxes, next.rect] : boxes;
    const { index } = await waitForClick(targets, () => (chosen === null ? question.correct : boxes.length));
    if (index === boxes.length) break;   // Next
    chosen = index;
    boxes.forEach((box, k) => {          // the chosen answer is outlined in green
      box.lineColor = k === chosen ? GAIN_COLOUR : WHITE;
      box.lineWidth = k === chosen ? 5 : 2;
    });
    if (!next) {
      next = makeWhiteButton('Next', [0.82, -0.94], 0.22, 0.08);
      showButton(next);
    }
  }
  const correct = chosen === question.correct;
  logEvent('quiz', { attempt, question: question.id, answer: 'ABC'[chosen], correct, rt: Number((now() - start).toFixed(3)) });
  clearScreen();
  return correct;
}

async function runMainTask(schedule) {
  // testing only: ?megablock=N starts directly at megablock N (as if the previous ones had been played)
  const first = Math.max(1, Number(URL_PARAMS.get('megablock')) || 1) - 1;
  if (first > 0) state.trialsDone = schedule[first - 1].ends_at_trial;
  for (let m = first; m < schedule.length; m++) {
    const megablock = schedule[m];
    const isLast = m === schedule.length - 1;
    await newEnvironmentScreen(megablock);

    for (let b = 0; ; b++) {
      const block = megablock.blocks[b];
      if (!block) throw new Error(`megablock ${megablock.megablock} has no block ${b + 1} left in the schedule`);
      const outcome = await runBlock(megablock, block);
      if (outcome === 'no_trials_remaining' || remainingTrials() <= 0) return outcome;
      if (!isLast && state.trialsDone >= megablock.ends_at_trial) break;  // next megablock
    }
  }
  return 'completed';
}

// ======================================================================================
// MEGABLOCK: new fishing spot
// ======================================================================================

let currentEnvironment = null;  // entry of CONFIG.environments (or the practice spot) shown now

async function newEnvironmentScreen(megablock) {
  currentEnvironment = megablock.environmentConfig;
  logEvent('new_environment', { phase: state.phase, megablock: megablock.megablock, environment: megablock.environment,
    trend: megablock.trend, background: currentEnvironment.name });
  clearScreen();
  drawBackground();
  show(makeText(state.phase === 'practice' ? 'Practice spot' : 'A new fishing spot!', [0, 0.1], 0.12));
  await wait(CONFIG.newEnvironmentDuration);
  clearScreen();
}

// ======================================================================================
// BLOCK: one day of fishing
// ======================================================================================

async function runBlock(megablock, block) {
  state.blockCount++;
  const zone = {
    net: 0,
    goal: null,
    option: null,      // option chosen on the previous trial (null = none yet)
    trial: 0,          // trials played in this block
    limit: block.trials.length,
    info: {            // copied into every data row of this block
      phase: state.phase, megablock: megablock.megablock, environment: megablock.environment, trend: megablock.trend,
      background: megablock.environmentConfig.name,
      block: state.blockCount, block_in_megablock: block.block_in_megablock, block_file: block.block_file,
    },
  };

  // New day: the scene with an empty net (same background: same fishing spot), and a Go button
  drawScene(zone);
  show(makeText('A new day of fishing begins.\nYour net is empty.', [0, 0.25], 0.08));
  const go = makeWhiteButton('Go', [0, -0.25], 0.3);
  showButton(go);
  await waitForClick([go.rect]);

  let outcome;
  while (true) {
    // trial 2 keeps the screen positions of trial 1, seen during goal setting (values: those of trial 2)
    await playTrial(zone, block.trials[zone.trial], block.trials[zone.trial === 1 ? 0 : zone.trial]);

    if (zone.goal !== null && zone.net >= zone.goal) { outcome = 'goal_reached'; break; }
    if (remainingTrials() <= 0) { outcome = 'no_trials_remaining'; break; }
    if (zone.trial >= zone.limit) { outcome = 'block_limit'; break; }

    if (zone.trial === 1) {
      await goalSettingScreen(zone, block.trials[0]);
    } else if (isProbeTrial(zone)) {
      if (await probeScreen(zone) === 'leave') { outcome = 'abandoned'; break; }
    } else {
      await fishAgainButton(zone);
    }
  }

  await endOfBlockScreen(zone, outcome);
  if (outcome !== 'no_trials_remaining' && state.phase !== 'practice') await endOfBlockRatings(zone);
  return outcome;
}

function isProbeTrial(zone) {
  if (CONFIG.noProbeInFirstBlock && state.blockCount === 1) return false;
  return zone.trial >= CONFIG.firstProbeTrial && (zone.trial - CONFIG.firstProbeTrial) % CONFIG.probeInterval === 0;
}

// ======================================================================================
// SCENE: what is always on screen during the fishing (no numbers except the coins)
//   - background of the fishing spot
//   - top right: money bag + coins, fuel gauge (remaining trials)
//   - bottom: net gauge (net icon + current creature, coloured fill, goal box)
// ======================================================================================

const VALUE_COLOUR = [-0.04, 0.9, 0.08];  // green value bars
const FUEL_COLOUR = [1, 0.49, -0.8];  // amber yellow (distinct from the orange of the octopus net)
const GAUGE = { left: -0.8, y: -0.85, height: 0.06, goalHeight: 0.07 };
const netToLength = (net) => Math.min(net, CONFIG.netGaugeMax) / CONFIG.netGaugeMax * CONFIG.netGaugeLength;
const lengthToNet = (length) => length / CONFIG.netGaugeLength * CONFIG.netGaugeMax;

/** Background of the fishing spot, with the coins and fuel panel unless withPanel = false. */
function drawBackground(withPanel = true) {
  drawBackgroundImage(backgroundFile(currentEnvironment));
  if (!withPanel) return;
  // coins and fuel in a dark panel, just below the coast band (top right)
  show(makePanel([0.79, 0.455], 0.36, 0.28, 0.3),
    makeImage(IMAGES.bag, [0.7, 0.509], [0.07, 0.13]),
    makeText(String(state.coins), [0.8, 0.509], 0.09),
    // fuel gauge: its length is the proportion of the session's trials still available
    makeImage(IMAGES.fuel, [0.665, 0.389], [0.05, 0.107]),   // 200 x 240 px icon, square pixels on a 16:9 screen
    makeBar(0.72, 0.389, 0.22, 0.045, 'black', 0.4),
    makeBar(0.72, 0.389, 0.22 * remainingTrials() / CONFIG.totalTrials, 0.045, FUEL_COLOUR));
}

/** Goal box of the net gauge: dark box with a white outline, from the start of the gauge to the goal. */
function makeGoalBox(goal) {
  return new visual.Rect({
    win: psychoJS.window, units: 'norm', pos: [GAUGE.left + netToLength(goal) / 2, GAUGE.y],
    width: netToLength(goal), height: GAUGE.goalHeight,
    fillColor: new util.Color([-0.7, -0.7, -0.7]), lineColor: WHITE, lineWidth: 3, opacity: 0.6,
  });
}

/**
 * Net gauge (bottom): background of the full gauge, goal box, coloured fill of the net, net icon with the creature
 * currently in the net. `increment` adds a green segment at the end of the fill (catch animation).
 */
function drawNetGauge(zone, { net = zone.net, increment = 0, goal = zone.goal } = {}) {
  const stims = [makeBar(GAUGE.left, GAUGE.y, CONFIG.netGaugeLength, GAUGE.height, 'black', 0.2)];
  if (goal !== null) stims.push(makeGoalBox(goal));
  // once a goal is set, the gauge never fills past it (a catch that passes the goal stops at the goal line)
  const capped = (x) => (goal !== null ? Math.min(x, goal) : x);
  const shownNet = capped(net);
  const shownTotal = capped(net + increment);
  if (shownNet > 0 && zone.option !== null) {
    stims.push(makeBar(GAUGE.left, GAUGE.y, netToLength(shownNet), GAUGE.height, CONFIG.optionColours[zone.option]));
  }
  if (shownTotal > shownNet) {
    stims.push(makeBar(GAUGE.left + netToLength(shownNet), GAUGE.y, netToLength(shownTotal) - netToLength(shownNet), GAUGE.height, VALUE_COLOUR));
  }
  if (zone.option !== null) stims.push(makeImage(IMAGES[zone.option], [-0.9, GAUGE.y], CREATURE_SIZE));
  stims.push(makeImage(IMAGES.net, [-0.9, GAUGE.y], [0.17, 0.2]));
  show(...stims);
  return stims;
}

/** A creature with its value bar: icon above, bar below (positions from the schedule). */
function drawCreature(name, pos, value) {
  const icon = makeImage(IMAGES[name], [pos[0], pos[1] + 0.225 + CONFIG.creatureYOffset], CREATURE_SIZE);
  const barLeft = pos[0] - netToLength(CONFIG.valueMax) / 2;  // bar centred under the creature
  const barY = pos[1] + 0.05 + CONFIG.creatureYOffset;
  show(icon,
    // same scale as the net gauge: a bar is exactly as long as what this catch would add to the net
    makeBar(barLeft, barY, netToLength(CONFIG.valueMax), 0.06, 'black', 0.2),
    makeBar(barLeft, barY, netToLength(Math.min(value, CONFIG.valueMax)), 0.06, VALUE_COLOUR));
  return icon;
}

const CREATURE_SIZE = [0.155, 0.2];

/** Calls update(e, t) on every frame for `duration` seconds: t goes from 0 to 1, e is t with a smooth start and stop. */
async function animate(duration, update) {
  const start = now();
  const total = duration * SPEED;
  while (true) {
    const t = total > 0 ? Math.min(1, (now() - start) / total) : 1;
    update(t * t * (3 - 2 * t), t);
    if (t >= 1) return;
    await nextFrame();
  }
}

/** Moves an image from `from` to `to` (norm units) in `duration` seconds, starting and stopping smoothly. */
async function glide(stim, from, to, duration) {
  await animate(duration, (e) => { stim.pos = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]; });
}

/** The scene with the net gauge only (between trials). */
function drawScene(zone) {
  clearScreen();
  drawBackground();
  drawNetGauge(zone);
}

// ======================================================================================
// TRIAL
// ======================================================================================

/** One trial: values from `row`, screen positions from `positionRow` (the scheduled ones unless given). */
async function playTrial(zone, row, positionRow = row) {
  zone.trial++;

  // Choice screen: the three creatures at their positions, each with its value bar.
  drawScene(zone);
  const creatures = CONFIG.options.map((name) => {
    const pos = [positionRow[`${name}_choice_width`], positionRow[`${name}_choice_height`]];
    return { name, pos, value: row[`${name}_val`], icon: drawCreature(name, pos, row[`${name}_val`]) };
  });

  const autoChoice = () => (zone.option !== null && Math.random() < 0.7
    ? CONFIG.options.indexOf(zone.option)
    : Math.floor(Math.random() * 3));
  const { index, rt } = await waitForClick(creatures.map((c) => c.icon), autoChoice);
  const chosen = creatures[index];
  state.trialsDone++;  // the fuel goes down when the catch is shown

  // Catch: switching to another creature empties the net first.
  const switched = zone.option !== null && chosen.name !== zone.option;
  const netBefore = zone.net;
  const gained = Math.round(chosen.value);
  zone.net = (switched ? 0 : zone.net) + gained;
  const optionBefore = zone.option;
  zone.option = chosen.name;

  logEvent('trial', {
    ...zone.info, trial_in_block: zone.trial, trial_in_session: state.trialsDone, remaining_trials: remainingTrials(),
    ...Object.fromEntries(creatures.flatMap((c) => [[`${c.name}_val`, c.value], [`${c.name}_x`, c.pos[0]], [`${c.name}_y`, c.pos[1]]])),
    choice: chosen.name, choice_x: chosen.pos[0], choice_y: chosen.pos[1], rt: Number(rt.toFixed(3)),
    switched, net_lost: switched ? netBefore : 0, gained, net: zone.net, goal: zone.goal, coins: state.coins,
  });

  // Catch animation (CONFIG.catchDuration): a net drops onto the chosen creature; where it lands, soft ripples spread
  // on the water, one after the other, and fade.
  //   first half : stay -> previous fill + green segment of the catch; switch -> net emptied
  //   second half: the net gauge shows the new content in the creature's colour
  clearScreen();
  drawBackground();
  const target = [chosen.pos[0], chosen.pos[1] + 0.225 + CONFIG.creatureYOffset];
  const ripples = [0, 1, 2].map(() => makeImage(IMAGES.ripple, [target[0], target[1] - 0.08], [0, 0]));
  const net = makeImage(IMAGES.net, [target[0], target[1] + 0.2], [0.2, 0.2]);
  for (const stim of [...ripples, net]) stim.opacity = 0;
  show(...ripples, makeImage(IMAGES[chosen.name], target, CREATURE_SIZE), net);
  const firstHalf = switched
    ? drawNetGauge({ ...zone, option: optionBefore }, { net: 0 })
    : drawNetGauge({ ...zone, option: optionBefore ?? chosen.name }, { net: netBefore, increment: gained });
  const drop = Math.min(0.3, CONFIG.catchDuration / 4);
  await animate(drop, (e, t) => {   // the net falls from above (faster and faster) and appears
    net.pos = [target[0], target[1] + 0.2 * (1 - t * t)];
    net.opacity = Math.min(1, 2 * t);
  });
  const spreading = animate(CONFIG.catchDuration - drop, (e, t) => {
    ripples.forEach((ripple, k) => {   // ring k starts at t = 0.2 k and lives 60 % of the time
      const u = Math.min(1, Math.max(0, (t - 0.2 * k) / 0.6));
      ripple.size = [0.08 + 0.34 * u, 0.025 + 0.1 * u];   // flat ellipse: the water is seen from above at an angle
      ripple.opacity = u > 0 ? 0.6 * (1 - u) * (1 - 0.25 * k) : 0;
    });
  });
  await wait(CONFIG.catchDuration / 2 - drop);
  hide(firstHalf);
  drawNetGauge(zone);
  await spreading;
}

async function fishAgainButton(zone) {
  drawScene(zone);
  await wait(CONFIG.fishAgainDelay);
  const button = makeWhiteButton('Fish again!', [0, 0]);
  showButton(button);
  await waitForClick([button.rect]);
}

// ======================================================================================
// GOAL SETTING (after trial 1): the participant clicks or drags on the net gauge; the creatures and their amounts
// of trial 1 stay on screen (not clickable)
// ======================================================================================

/** Coins earned for reaching a goal (shown while setting the goal, and paid when it is reached). */
const coinsForGoal = (goal) => Math.round(goal / CONFIG.pointsPerCoin);

async function goalSettingScreen(zone, row) {
  drawScene(zone);
  for (const name of CONFIG.options) {
    drawCreature(name, [row[`${name}_choice_width`], row[`${name}_choice_height`]], row[`${name}_val`]);
  }
  show(makeText('Set your goal for today\n(click on the gauge)', [0, 0.1], 0.08));   // centre: free of creatures
  // allowed range (imposed minimum and maximum): lighter band around the gauge
  const minLength = netToLength(CONFIG.goalMin);
  const maxLength = netToLength(CONFIG.goalMax);
  show(makeBar(GAUGE.left + minLength, GAUGE.y, maxLength - minLength, 0.13, 'white', 0.25));

  const snap = (net) => {
    const stepped = CONFIG.goalMin + Math.round((net - CONFIG.goalMin) / CONFIG.goalStep) * CONFIG.goalStep;
    return Math.min(CONFIG.goalMax, Math.max(CONFIG.goalMin, stepped));
  };
  const start = now();
  let goal = null;
  let goalStims = [];
  let button = null;
  let firstChoiceRt = null;

  if (AUTO) {
    await wait(FAST ? 0 : 1);
    goal = snap(CONFIG.goalMin + Math.random() * (CONFIG.goalMax - CONFIG.goalMin));
  } else {
    while (true) {
      await nextFrame();
      if (mouse.getPressed()[0] === 1) {
        const [x, y] = mouse.getPos();
        const onGauge = Math.abs(y - GAUGE.y) < 0.1 && x >= GAUGE.left - 0.05 && x <= GAUGE.left + CONFIG.netGaugeLength + 0.05;
        if (onGauge) {
          const newGoal = snap(lengthToNet(x - GAUGE.left));
          if (newGoal !== goal) {
            goal = newGoal;
            if (firstChoiceRt === null) firstChoiceRt = now() - start;
            hide(goalStims);
            // goal box and possible gain (money bag + coins earned if this goal is reached) above its end
            const labelX = Math.min(GAUGE.left + netToLength(goal), 0.86);   // stays on screen for the highest goals
            goalStims = [makeGoalBox(goal),
              makeImage(IMAGES.bag, [labelX - 0.04, GAUGE.y + 0.13], [0.06, 0.107]),
              makeText(`+ ${coinsForGoal(goal)}`, [labelX + 0.045, GAUGE.y + 0.13], 0.06, 0.3, GAIN_COLOUR)];
            show(...goalStims);
          }
          continue;
        }
      }
      if (goal !== null && button === null) {
        button = makeWhiteButton('Confirm', [0, -0.3], 0.35);
        showButton(button);
      }
      if (button !== null && mouse.getPressed()[0] === 1 && button.rect.contains(mouse)) break;
    }
  }
  zone.goal = goal;
  logEvent('goal_setting', {
    ...zone.info, trial_in_block: zone.trial, trial_in_session: state.trialsDone, net: zone.net, goal: zone.goal,
    goal_first_click_rt: firstChoiceRt === null ? null : Number(firstChoiceRt.toFixed(3)), rt: Number((now() - start).toFixed(3)),
  });
  clearScreen();
}

// ======================================================================================
// PROBE (continue / leave)
// ======================================================================================

async function probeScreen(zone) {
  drawScene(zone);
  show(makeText('Keep fishing or leave?\nIf you leave, your net is lost.', [0, 0.35], 0.07));
  const stay = makeWhiteButton('Keep fishing', [-0.35, -0.2], 0.4);
  const leave = makeWhiteButton('Leave', [0.35, -0.2], 0.4);
  showButton(stay);
  showButton(leave);
  const { index, rt } = await waitForClick([stay.rect, leave.rect], () => (Math.random() < 0.15 ? 1 : 0));
  const decision = index === 0 ? 'continue' : 'leave';
  logEvent('probe', { ...zone.info, trial_in_block: zone.trial, trial_in_session: state.trialsDone, net: zone.net, goal: zone.goal, decision, rt: Number(rt.toFixed(3)) });
  clearScreen();
  return decision;
}

// ======================================================================================
// END OF THE DAY: outcome, then ratings
// ======================================================================================

// Merchant boat (images/merchant_boat.png, 650 x 325 px at the scale of the 2048 x 1152 backgrounds, waterline at
// 262.5 px): placed with its waterline on the fishing boat's (y = -0.6), alongside it on the right.
const MERCHANT = { size: [650 / 1024, 325 / 576], y: -0.6 + (262.5 - 162.5) / 576, x: 0.52, offScreenX: 1.35 };

/**
 * End of the day: same scene as during the fishing (background, net gauge with the goal) and, in the middle, a panel:
 * outcome, what was sold (money bag + coins gained), total. When the goal is reached, a merchant boat comes to buy
 * the catch (the net empties), stays a moment and sails away.
 */
async function endOfBlockScreen(zone, outcome) {
  const sold = outcome === 'goal_reached';
  const coins = sold ? coinsForGoal(zone.goal) : 0;   // the gain of the goal set, even if the last catch passes it
  state.coins += coins;
  logEvent('block_end', {
    ...zone.info, outcome, trials_in_block: zone.trial, trial_in_session: state.trialsDone,
    net: zone.net, goal: zone.goal, coins_gained: coins, coins: state.coins,
  });

  const titles = {
    goal_reached: ['Goal reached!', [-0.2, 0.85, -0.2]],
    abandoned: ['You left', [1, 0.45, 0.3]],
    block_limit: ['End of the day', [1, 0.6, -0.2]],
    no_trials_remaining: ['Out of fuel', [1, 0.45, 0.3]],
  };
  const [title, colour] = titles[outcome];

  clearScreen();
  drawBackground(false);
  const gauge = drawNetGauge(zone);
  show(makePanel([0, 0.15], 0.8, 0.85, 0.35), makeText(title, [0, 0.45], 0.1, 1.6, new util.Color(colour)));
  const bag = makeImage(IMAGES.bag, [-0.09, 0.1], [0.1, 0.18]);
  const result = [makeText(sold ? 'Catch sold' : 'Nothing to sell', [0, 0.28], 0.065), bag,
    makeText(`+ ${coins}`, [0.06, 0.1], 0.1, 1.6, sold ? GAIN_COLOUR : new util.Color([0.4, 0.4, 0.4])),
    makeText(`Total: ${state.coins} coins`, [0, -0.1], 0.065)];
  if (sold) {
    // "Goal reached!" from the start; the merchant boat comes alongside the fishing boat, stays while the catch is
    // sold (the net empties, the coins are shown), then turns around and sails away; the button appears after it
    const ship = makeImage(IMAGES.merchant, [MERCHANT.offScreenX, MERCHANT.y], MERCHANT.size);
    show(ship);
    await glide(ship, [MERCHANT.offScreenX, MERCHANT.y], [MERCHANT.x, MERCHANT.y], CONFIG.merchantDuration);
    hide(gauge);
    drawNetGauge({ ...zone, option: null }, { net: 0 });
    show(...result);
    await wait(CONFIG.merchantStay);
    ship.flipHoriz = true;
    await glide(ship, [MERCHANT.x, MERCHANT.y], [MERCHANT.offScreenX, MERCHANT.y], CONFIG.merchantDuration);
  } else {
    bag.opacity = 0.4;
    show(...result);
    await wait(CONFIG.outcomeMinDuration);
  }
  const button = makeWhiteButton('Continue', [0, -0.5], 0.35);
  showButton(button);
  await waitForClick([button.rect]);
  clearScreen();
}

/**
 * Rating screen on the plain sea: sliders with a question each and a Confirm button that works once every slider
 * has been answered. Returns the ratings (in the order of `items`) and the response time.
 */
async function sliderScreen(title, items, autoValue) {
  clearScreen();
  drawBackgroundImage(IMAGES.plainSea);
  show(makeText(title, [0, 0.82], 0.065));
  const sliders = items.map((item) => {
    show(makeText(item.question, [0, item.y + 0.12], 0.055));
    const slider = new visual.Slider({
      win: psychoJS.window, pos: [0, item.y], size: [1.0, 0.05], units: 'norm', labels: item.labels, ticks: item.ticks,
      granularity: 0, style: ['RATING'], fontFamily: TEXT_FONT, fontSize: 0.045,
      color: WHITE, lineColor: WHITE, markerColor: new util.Color([1, -0.24, -0.18]),
    });
    show(slider);
    return slider;
  });
  const button = makeWhiteButton('Confirm', [0, -0.82], 0.3, 0.1);
  showButton(button);
  const start = now();
  if (AUTO) {
    await wait(FAST ? 0 : 1);
    clearScreen();
    return { ratings: items.map((item) => autoValue(item)), rt: now() - start };
  }
  while (true) {
    await waitForClick([button.rect]);
    const ratings = sliders.map((slider) => slider.getRating());
    if (ratings.every((r) => r !== undefined)) { clearScreen(); return { ratings, rt: now() - start }; }
  }
}

async function endOfBlockRatings(zone) {
  const info = { ...zone.info, goal: zone.goal };
  const random = (item) => item.ticks[0] + Math.random() * (item.ticks[item.ticks.length - 1] - item.ticks[0]);

  const emotions = ['excited', 'frustrated', 'satisfied', 'anxious'];
  let r = await sliderScreen('Right now, how much do you feel...', emotions.map((emotion, i) => (
    { question: emotion[0].toUpperCase() + emotion.slice(1), labels: ['Not at all', 'Very much'], ticks: [0, 10], y: 0.45 - i * 0.37 }
  )), random);
  logEvent('rating_emotions', { ...info, ...Object.fromEntries(emotions.map((e, i) => [e, r.ratings[i]])), rt: Number(r.rt.toFixed(3)) });

  r = await sliderScreen('Today, the amounts of the creatures...', [
    { question: 'Direction', labels: ['Decreased', 'Stayed stable', 'Increased'], ticks: [-1, 0, 1], y: 0.3 },
    { question: 'How sure are you?', labels: ['Not sure at all', 'Completely sure'], ticks: [0, 100], y: -0.3 },
  ], random);
  logEvent('rating_trend', { ...info, trend_direction: r.ratings[0], trend_certainty: r.ratings[1], rt: Number(r.rt.toFixed(3)) });
}

// ======================================================================================
// END
// ======================================================================================

async function endScreen(outcome) {
  logEvent('session_end', { outcome, trials: state.trialsDone, blocks: state.blockCount, coins: state.coins });
  if (AUTO) printAutoSummary();
  await messageScreen(`Thank you!\n\nYou earned ${state.coins} coins in total.`, 'Finish');
  sessionStatus = 'finished';
  await psychoJS.quit({ message: 'Your data have been saved.', isCompleted: true });
}

/** Auto mode: prints counts (main task only) in the console and the page title, to check a simulated session. */
function printAutoSummary() {
  const practice = rows.filter((r) => r.phase === 'practice');
  const main = rows.filter((r) => r.phase !== 'practice');
  const count = (event, key, value) => main.filter((r) => r.event === event && (key === undefined || r[key] === value)).length;
  const summary = {
    practice_trials: practice.filter((r) => r.event === 'trial').length,
    practice_days: practice.filter((r) => r.event === 'block_end').length,
    trials: count('trial'),
    blocks: count('block_end'),
    goal_reached: count('block_end', 'outcome', 'goal_reached'),
    abandoned: count('block_end', 'outcome', 'abandoned'),
    block_limit: count('block_end', 'outcome', 'block_limit'),
    no_trials_remaining: count('block_end', 'outcome', 'no_trials_remaining'),
    probes: count('probe'),
    environments: count('new_environment'),
    coins: state.coins,
    trials_per_megablock: Object.fromEntries([...new Set(main.map((r) => r.megablock).filter(Boolean))]
      .map((m) => [m, main.filter((r) => r.event === 'trial' && r.megablock === m).length])),
  };
  console.log(`AUTO_SUMMARY ${JSON.stringify(summary)}`);
  document.title = `AUTO_SUMMARY ${JSON.stringify(summary)}`;
}
