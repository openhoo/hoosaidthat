import config from './playwright.config.mjs';

if (process.env.SCREEN_READER !== 'jaws') throw new Error('JAWS navigation checks require the JAWS guest');

export default { ...config, testMatch: 'jaws-navigation.spec.mjs' };
