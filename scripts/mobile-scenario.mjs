// Commands are explicitly mapped to actions supported by the Android bridge.
const actions = Object.freeze(Object.assign(Object.create(null), {
  forward: 'moveToNextObjectFlat', backward: 'moveToPreviousObjectFlat', current: 'readCurrent',
  activate: 'activate', nextButton: 'nextButton', previousButton: 'previousButton',
  nextHeading: 'nextHeading', previousHeading: 'previousHeading', nextLink: 'nextLink', previousLink: 'previousLink',
}));
const nonempty = s => typeof s === 'string' && Boolean(s.trim());
const fields = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));

export function androidScenario(s) {
  if (!fields(s, ['url', 'readyText', 'steps']) || !nonempty(s.url)) throw Error('Android scenarios require a website URL and steps.');
  const url = new URL(s.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use an HTTP(S) URL without embedded credentials.');
  if ('readyText' in s && !nonempty(s.readyText)) throw Error('readyText must be nonempty.');
  if (!Array.isArray(s.steps) || !s.steps.length || s.steps.length > 100 || Buffer.byteLength(JSON.stringify(s)) > 32768) throw Error('Expected 1–100 steps in at most 32 KiB.');
  for (const [index, step] of s.steps.entries()) {
    if (!fields(step, ['action','until','expect','maxMoves']) || !Object.hasOwn(actions, step.action) ||
        ('expect' in step && !nonempty(step.expect)) ||
        ('until' in step ? (!nonempty(step.until) || 'expect' in step || ['current','activate'].includes(step.action) ||
         !Number.isInteger(step.maxMoves) || step.maxMoves < 1 || step.maxMoves > 50) : 'maxMoves' in step)) {
      throw Error('Invalid Android scenario step ' + (index + 1) + '. Supported actions: ' + Object.keys(actions).join(', '));
    }
  }
  return s;
}

export async function runAndroidSteps(scenario, act) {
  for (const [index, step] of androidScenario(scenario).steps.entries()) {
    const target = step.expect ?? step.until;
    for (let move = 1; move <= (step.maxMoves ?? 1); move++) {
      const observation = await act(actions[step.action]);
      if (observation.timedOut) throw Error('TalkBack did not settle at step ' + (index + 1));
      const speech = observation.speechEvents.map(e => e.text).filter(nonempty);
      if (speech.length && (!target || speech.some(text => text.includes(target)))) break;
      if (move === (step.maxMoves ?? 1)) throw Error('TalkBack did not speak ' + JSON.stringify(target ?? 'any text') + ' at step ' + (index + 1) + '. Heard: ' + JSON.stringify(speech));
    }
  }
}
