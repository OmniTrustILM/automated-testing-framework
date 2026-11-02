import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { http, json, timestampRequest, exportRows } from './helpers.mjs';

export function product(baseUrl, adminToken, separator = ',') {
    const base = baseUrl.replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
    const filters = identifier => [{ fieldSource: 'property', fieldIdentifier: 'AUDIT_LOG_ACTOR_DELEGATE_IDENTIFIER', condition: 'EQUALS', value: identifier }];
    const list = filters => json(`${base}/api/v1/auditLogs`, { method: 'POST', headers, body: JSON.stringify({ pageNumber: 1, itemsPerPage: 1000, filters }) });
    const poll = async (matches, timeout = 30_000) => {
        const deadline = Date.now() + timeout;
        do {
            const response = await list([]);
            const records = response.items.filter(matches);
            if (records.length) return records;
            await setTimeout(100);
        } while (Date.now() < deadline);
        throw new Error('Audit record did not arrive for this request');
    };
    return {
        async provider(name, settings) {
            await http(`${base}/api/v1/settings/authentication/oauth2Providers/${encodeURIComponent(name)}`, { method: 'PUT', headers, body: JSON.stringify(settings) });
        },
        async removeProvider(name) {
            await http(`${base}/api/v1/settings/authentication/oauth2Providers/${encodeURIComponent(name)}`, { method: 'DELETE', headers }, [200, 204, 404]);
        },
        async invoke(path, token, tsp = false) {
            const marker = `ilm-delegation/${randomUUID()}`;
            const response = await http(`${base}${path}`, {
                method: tsp ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'User-Agent': marker,
                    'Content-Type': tsp ? 'application/timestamp-query' : 'application/json' },
                ...(tsp ? { body: timestampRequest() } : {}),
            }, [200, 401, 403]);
            return { ...response, marker };
        },
        audit: (marker, timeout) => poll(item => item.source?.userAgent === marker, timeout),
        async watermark() {
            const response = await list([]);
            return response.items.reduce((maximum, item) => Math.max(maximum, Number(item.id)), 0);
        },
        // Authentication filters can refuse before MVC populates SourceRecord. A unique provider plus
        // an ID watermark correlates those failures without accepting an earlier refusal from this run.
        auditFailure: (afterId, provider, identifier) => poll(item => Number(item.id) > afterId && item.operationResult === 'failure'
            && item.message?.includes(provider) && item.message?.includes(identifier)),
        filtered: identifier => list(filters(identifier)),
        async export(identifier) {
            const response = await http(`${base}/api/v1/auditLogs/export`, { method: 'POST', headers, body: JSON.stringify(filters(identifier)) });
            return exportRows(response.body, separator);
        },
        searchable: () => json(`${base}/api/v1/auditLogs/search`, { headers }),
    };
}
