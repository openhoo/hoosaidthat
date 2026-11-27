// Example child for: hoosaidthat-record android --avd NAME -- node android-settings.mjs
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

const serial = process.env.ANDROID_SERIAL;
if (!/^emulator-\d+$/.test(serial)) throw new Error('Run this example inside hoosaidthat-record android.');
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' });
adb('shell', 'am', 'start', '-W', '-a', 'android.settings.SETTINGS');
await wait(4000);
adb('shell', 'am', 'start', '-W', '-a', 'android.settings.DISPLAY_SETTINGS');
await wait(4000);
const foreground = adb('shell', 'dumpsys', 'activity', 'activities').split('\n').find(line => line.includes('topResumedActivity'));
if (!foreground?.includes('com.android.settings')) throw new Error('Settings is not in the foreground.');
adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
await wait(3500);
