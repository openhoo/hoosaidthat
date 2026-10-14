import { expect, test } from '@openhoo/hoosaidthat';

// Keep these tests in one worker: an accidental Chromium shutdown only becomes
// visible when the next isolated context uses the same native browser.
test.describe('native browser lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  test('active reader survives explicit page close and asynchronous cleanup', async ({ page, screenReader }) => {
    await page.setContent('<title>Page close fixture</title><button>First isolated page</button>');
    await screenReader.returnToPage();
    await screenReader.focus(page.getByRole('button'));
    await expect(screenReader).toHaveSpoken(/First isolated page/);
    await page.close();
    await new Promise(resolve => setTimeout(resolve, 750));
  });

  test('isolated page after explicit close has physical native reader focus', async ({ page, screenReader }) => {
    await page.setContent('<title>After page close</title><button>Native focus survives page close</button>');
    await screenReader.returnToPage();
    await screenReader.focus(page.getByRole('button'));
    await expect(screenReader).toHaveSpoken(/Native focus survives page close/);
  });

  test('active reader survives explicit context close and asynchronous cleanup', async ({ page, context, screenReader }) => {
    await page.setContent('<title>Context close fixture</title><button>Third isolated page</button>');
    await screenReader.returnToPage();
    await screenReader.focus(page.getByRole('button'));
    await expect(screenReader).toHaveSpoken(/Third isolated page/);
    await context.close();
    await new Promise(resolve => setTimeout(resolve, 750));
  });

  test('isolated page after context close has physical native reader focus', async ({ page, screenReader }) => {
    await page.setContent('<title>After context close</title><button>Native focus survives context close</button>');
    await screenReader.returnToPage();
    await screenReader.focus(page.getByRole('button'));
    await expect(screenReader).toHaveSpoken(/Native focus survives context close/);
  });

  test('active reader survives primary close followed by final secondary page close', async ({ page, context, screenReader }) => {
    await page.setContent('<title>Secondary page close fixture</title><button>Primary before secondary close</button>');
    await screenReader.returnToPage();
    await screenReader.focus(page.getByRole('button'));
    await expect(screenReader).toHaveSpoken(/Primary before secondary close/);
    const secondary = await context.newPage();
    await secondary.setContent('<title>Last secondary window</title><button>Secondary page</button>');
    await page.close();
    await secondary.close();
    await new Promise(resolve => setTimeout(resolve, 750));
  });

  test('isolated page after secondary close has physical native reader focus', async ({ page, screenReader }) => {
    await page.setContent('<title>After secondary close</title><button>Native focus survives secondary close</button>');
    await screenReader.returnToPage();
    await screenReader.focus(page.getByRole('button'));
    await expect(screenReader).toHaveSpoken(/Native focus survives secondary close/);
  });

  test('active reader survives concurrent final page closes', async ({ page, context, screenReader }) => {
    await page.setContent('<title>Concurrent page close fixture</title><button>Primary before concurrent close</button>');
    await screenReader.returnToPage();
    await screenReader.focus(page.getByRole('button'));
    await expect(screenReader).toHaveSpoken(/Primary before concurrent close/);
    const second = await context.newPage();
    const third = await context.newPage();
    await Promise.all([page.close(), second.close(), third.close()]);
    await new Promise(resolve => setTimeout(resolve, 750));
  });

  test('isolated page after concurrent close has physical native reader focus', async ({ page, screenReader }) => {
    await page.setContent('<title>After concurrent close</title><button>Native focus survives concurrent close</button>');
    await screenReader.returnToPage();
    await screenReader.focus(page.getByRole('button'));
    await expect(screenReader).toHaveSpoken(/Native focus survives concurrent close/);
  });
});
