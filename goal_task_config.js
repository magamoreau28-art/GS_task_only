/*
 * Parameters of the goal-setting fishing task.
 * Everything that may change between the online pilot and the fMRI version is here,
 * so the task code itself does not need to be edited.
 */

export const CONFIG = {
  // Schedule exported by Simulation/schedule.py (megablocks.csv, block_index.csv, blocks/*.csv): the same for every
  // participant (trends and blocks in the same order); only the visuals of the environments change between participants.
  scheduleDir: 'schedules_fmri',

  // Session
  totalTrials: 400,          // the game stops when this number of trials is reached, even mid-block

  // Instructions: images/instructions/instructions_00.jpg ... (1920 x 1080, exported from instructions.pptx). All but the
  // last are shown before the practice; the last one ("Your fishing trip begins!") after it.
  instructionSlides: 25,
  // Practice: days played before the main task, in this order (stable values, Simulation/schedule.py
  // export_practice_files); its fuel and coins are not counted, and there are no end-of-day ratings.
  // Practice spot: the open sea (sky, sea and boat, no coast; tools/make_environments_boat.py open_sea).
  practiceDays: ['practice/practice_day1.csv', 'practice/practice_day2.csv', 'practice/practice_day3.csv'],
  practiceEnvironment: { name: 'Practice spot', background: 'open_sea.png' },

  // Goal (in net points; the gauge spans goalMin..goalMax, same scale in every block)
  goalMin: 500,
  goalMax: 2000,
  goalStep: 50,

  // Probe (continue / abandon): after trial firstProbeTrial of a block, then every probeInterval trials
  firstProbeTrial: 3,
  probeInterval: 2,
  noProbeInFirstBlock: false, // true = the very first block of the session cannot be abandoned (no probe in it)

  // Coins earned when the goal is reached: goal / pointsPerCoin, rounded (a catch past the goal adds nothing)
  pointsPerCoin: 50,         // = goalStep: each goal step is worth exactly 1 coin, so two different goals never pay the same

  // Durations (seconds)
  newEnvironmentDuration: 3,
  catchDuration: 2,
  fishAgainDelay: 0.5,       // the "Fish again!" button appears after this delay
  outcomeMinDuration: 1.5,   // end-of-day screen: the button appears after this delay
  merchantDuration: 1.5,     // goal reached: the merchant boat arrives in this time, and leaves in this time (while the outcome is shown)

  // Option names as in the schedule files (columns <name>_val, <name>_choice_width, <name>_choice_height)
  options: ['octopus', 'fish', 'stingray'],
  optionImages: { octopus: 'images/octopus.png', fish: 'images/fish.png', stingray: 'images/stingray.png' },
  // colour of the net gauge when it holds this creature (same colours as the previous task)
  optionColours: { fish: [0.26, 0.07, 0.76], stingray: [-0.74, 0.23, 0.73], octopus: [0.96, 0.2, -0.37] },

  // Display scale (no numbers are shown: values are lengths, in screen units 'norm', width 2 = full screen).
  // Value bars and net gauge share ONE scale: a value bar is as long as what the catch adds to the net.
  valueMax: 300,             // highest possible value (schedule bound): length of the grey background of a value bar
  netGaugeMax: 2000,         // value of a full net gauge = goalMax: the highest goal fills the whole gauge
                             // (a last catch that passes the goal is cut at the end of the gauge)
  netGaugeLength: 1.7,       // length of the full net gauge at the bottom of the screen (from x = -0.8 to 0.9)

  // Creatures are drawn lower than the schedule positions so that the top creature stays below the horizon
  // of the environment backgrounds (top 19 % of the screen).
  creatureYOffset: -0.175,

  // Backgrounds are assigned to the megablocks in a random order drawn from the participant id (the same id always
  // gets the same order), so that a background is not tied to a trend across participants. false = order below.
  randomEnvironmentOrder: true,
  // With random order: each run (3 environments) shows one environment of each `group` (similar landscapes), so that
  // similar-looking seas never appear in the same run. Groups are not tied to trends.
  oneOfEachGroupPerRun: true,

  // Environments (backgrounds). Without random order, environment k of megablocks.csv shows the k-th background.
  // group: similar landscapes (built coast / cold, rocky / green), see oneOfEachGroupPerRun.
  // background: image file in environmentFolder, made by tools/make_environments_boat.py (sea surface with the
  // fishing boat; the coast on the horizon is drawn in tools/make_environments.py).
  environmentFolder: 'images/environments_boat',
  environments: [
    { name: 'Tropical island', group: 'green', background: 'tropical.png' },
    { name: 'City', group: 'built', background: 'new_york.png' },
    { name: 'Ice', group: 'cold', background: 'ice.png' },
    { name: 'Cliffs', group: 'cold', background: 'cliffs.png' },
    { name: 'Countryside', group: 'green', background: 'countryside.png' },
    { name: 'Fishing port', group: 'built', background: 'port.png' },
    { name: 'Beach resort', group: 'built', background: 'resort.png' },
    { name: 'Jungle', group: 'green', background: 'jungle.png' },
    { name: 'Fjord', group: 'cold', background: 'fjord.png' },
  ],
};
