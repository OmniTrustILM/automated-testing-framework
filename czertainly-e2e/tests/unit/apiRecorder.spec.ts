/**
 * ApiRecorder on a page whose requests are all fulfilled by a route (nothing leaves the browser): it records only between
 * start() and stop(), only `/api/` paths, and nonReadsSince() keeps writes and POST searches.
 */
import { expect, test } from '@playwright/test';
import { ApiRecorder } from '../../utils/network/apiRecorder';

// records /api/ requests between start() and stop() only; mark / since / nonReadsSince bracket a window
test('records only /api/ requests between start() and stop(); mark, since and nonReadsSince bracket', async ({ page }) => {
    await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>ok</p>' }));
    await page.goto('http://127.0.0.1:9/administrator/');
    const send = (method: string, path: string) => page.evaluate(([m, p]) => fetch(p, { method: m }).then((r) => r.status), [method, path]);
    const recorder = new ApiRecorder(page);
    await send('GET', '/api/v1/before');
    expect(recorder.recording).toBe(false);
    recorder.start().start();
    const mark = recorder.mark();
    await send('GET', '/api/v1/certificates/x');
    await send('POST', '/api/v2/certificates/search');
    await send('GET', '/static/app.js');
    await send('DELETE', '/api/v1/groups/x');
    expect(recorder.since(mark)).toEqual([
        { method: 'GET', path: '/api/v1/certificates/x' },
        { method: 'POST', path: '/api/v2/certificates/search' },
        { method: 'DELETE', path: '/api/v1/groups/x' },
    ]);
    expect(recorder.nonReadsSince(mark).map((r) => r.method)).toEqual(['POST', 'DELETE']);
    recorder.stop();
    await send('PUT', '/api/v1/after');
    expect(recorder.since(0)).toHaveLength(3);
    expect(recorder.recording).toBe(false);
});
