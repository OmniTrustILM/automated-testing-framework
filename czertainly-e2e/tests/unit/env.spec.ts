/**
 * Unit tests for the parts of env.ts that compute a value rather than read one.
 *
 * SMK-005 derives the domain its HTTP-01 solver answers on from BASE_URL, and chooses how the
 * solver is routed. A wrong value in either fails the smoke run minutes later as an unreachable
 * challenge — far from the cause. Pinning them here keeps that failure next to the code.
 */
import { test, expect } from '@playwright/test';
import { acmeSolverFrom, parentDomainOf } from '../../utils/env';
import { http01Solver } from '../../utils/certManagerUtils';

test('the solver domain is BASE_URL\'s host without its first label', () => {
    expect(parentDomainOf('https://fe-pr-1.preview.example.com/')).toBe('preview.example.com');
    expect(parentDomainOf('https://qa.example.com')).toBe('example.com');
});

test('port and path do not leak into the solver domain', () => {
    expect(parentDomainOf('https://env.example.com:8443/administrator/')).toBe('example.com');
});

test('without a gateway the solver is an Ingress of the given class, nginx by default', () => {
    expect(acmeSolverFrom(undefined, 'traefik')).toEqual({ kind: 'ingress', ingressClassName: 'traefik' });
    expect(acmeSolverFrom('', undefined)).toEqual({ kind: 'ingress', ingressClassName: 'nginx' });
    expect(http01Solver(acmeSolverFrom(undefined, 'nginx'), 'runner'))
        .toEqual({ ingress: { ingressClassName: 'nginx' } });
});

test('a gateway wins over an ingress class and routes through that Gateway in the run\'s namespace', () => {
    const solver = acmeSolverFrom('acme-solver', 'nginx');
    expect(solver).toEqual({ kind: 'gateway', gatewayName: 'acme-solver' });
    expect(http01Solver(solver, 'runner')).toEqual({
        gatewayHTTPRoute: {
            parentRefs: [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'acme-solver', namespace: 'runner' }],
        },
    });
});
