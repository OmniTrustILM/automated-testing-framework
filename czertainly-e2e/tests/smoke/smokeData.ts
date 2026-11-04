/**
 * Sidebar entries the smoke checks. `testId` is the FE `data-testid` (since fe-administrator 2.19.0, #1805):
 * `sidebar-<entry>` for a top-level entry, `sidebar-<parent>-<entry>` for a submenu entry.
 * Locating by test id does not depend on the markup between <li> and the entry, which FE changes
 * (tooltip wrappers since fe-administrator#2399).
 */
export type SidebarItem = {
    role: 'link' | 'button';
    name: string;
    testId: string;
    urlHint?: RegExp;
    children?: readonly SidebarItem[];
};

export type NavigableSidebarItem = {
    name: string;
    testId: string;
    urlHint: RegExp;
    parentTestId?: string;
};

export const sidebarItems: readonly SidebarItem[] = [
    {
        role: 'button',
        name: 'Dashboard',
        testId: 'sidebar-dashboard',
        children: [
            { role: 'link', name: 'Certificates', testId: 'sidebar-dashboard-certificates', urlHint: /\/dashboard\/certificates/i },
            { role: 'link', name: 'Secrets', testId: 'sidebar-dashboard-secrets', urlHint: /\/dashboard\/secrets/i },
            { role: 'link', name: 'Signing Records', testId: 'sidebar-dashboard-signing-records', urlHint: /\/dashboard\/signing-records/i },
        ],
    },
    { role: 'link', name: 'Certificates', testId: 'sidebar-certificates', urlHint: /\/certificates/i },
    { role: 'link', name: 'Keys', testId: 'sidebar-keys', urlHint: /keys/i },
    { role: 'link', name: 'Discoveries', testId: 'sidebar-discoveries', urlHint: /discoveries/i },
    { role: 'link', name: 'Connectors', testId: 'sidebar-connectors', urlHint: /connectors/i },
    { role: 'link', name: 'Secrets', testId: 'sidebar-secrets', urlHint: /\/secrets/i },
    { role: 'link', name: 'CBOMs', testId: 'sidebar-cboms', urlHint: /\/cboms/i },
    { role: 'link', name: 'Signing Records', testId: 'sidebar-signingrecords', urlHint: /\/signingrecords/i },
    {
        role: 'button',
        name: 'Access Control',
        testId: 'sidebar-access-control',
        children: [
            { role: 'link', name: 'Users', testId: 'sidebar-access-control-users', urlHint: /users/i },
            { role: 'link', name: 'Roles', testId: 'sidebar-access-control-roles', urlHint: /roles/i },
        ],
    },
    {
        role: 'button',
        name: 'Profiles',
        testId: 'sidebar-profiles',
        children: [
            { role: 'link', name: 'RA Profiles', testId: 'sidebar-profiles-raprofiles', urlHint: /raprofiles/i },
            { role: 'link', name: 'Token Profiles', testId: 'sidebar-profiles-tokenprofiles', urlHint: /tokenprofiles/i },
            { role: 'link', name: 'Compliance Profiles', testId: 'sidebar-profiles-complianceprofiles', urlHint: /complianceprofiles/i },
            { role: 'link', name: 'Notification Profiles', testId: 'sidebar-profiles-notificationprofiles', urlHint: /notificationprofiles/i },
            { role: 'link', name: 'Vault Profiles', testId: 'sidebar-profiles-vaultprofiles', urlHint: /vaultprofiles/i },
            { role: 'link', name: 'Signing Profiles', testId: 'sidebar-profiles-signingprofiles', urlHint: /signingprofiles/i },
        ],
    },
    {
        role: 'button',
        name: 'Inventory',
        testId: 'sidebar-inventory',
        children: [
            { role: 'link', name: 'Credentials', testId: 'sidebar-inventory-credentials', urlHint: /credentials/i },
            { role: 'link', name: 'Authorities', testId: 'sidebar-inventory-authorities', urlHint: /authorities/i },
            { role: 'link', name: 'Tokens', testId: 'sidebar-inventory-tokens', urlHint: /tokens/i },
            { role: 'link', name: 'Groups', testId: 'sidebar-inventory-groups', urlHint: /groups/i },
            { role: 'link', name: 'Entities', testId: 'sidebar-inventory-entities', urlHint: /entities/i },
            { role: 'link', name: 'Locations', testId: 'sidebar-inventory-locations', urlHint: /locations/i },
            { role: 'link', name: 'Vaults', testId: 'sidebar-inventory-vaults', urlHint: /\/vaults/i },
        ],
    },
    {
        role: 'button',
        name: 'Protocols',
        testId: 'sidebar-protocols',
        children: [
            { role: 'link', name: 'ACME Accounts', testId: 'sidebar-protocols-acmeaccounts', urlHint: /acmeaccounts/i },
            { role: 'link', name: 'ACME Profiles', testId: 'sidebar-protocols-acmeprofiles', urlHint: /acmeprofiles/i },
            { role: 'link', name: 'CMP Profiles', testId: 'sidebar-protocols-cmpprofiles', urlHint: /cmpprofiles/i },
            { role: 'link', name: 'SCEP Profiles', testId: 'sidebar-protocols-scepprofiles', urlHint: /scepprofiles/i },
            { role: 'link', name: 'TSP Profiles', testId: 'sidebar-protocols-tspprofiles', urlHint: /tspprofiles/i },
        ],
    },
    {
        role: 'button',
        name: 'Approvals',
        testId: 'sidebar-approvals',
        children: [
            { role: 'link', name: 'Approval Profiles', testId: 'sidebar-approvals-approvalprofiles', urlHint: /approvalprofiles/i },
            { role: 'link', name: 'Approval List', testId: 'sidebar-approvals-approvals', urlHint: /approvals/i },
        ],
    },
    { role: 'link', name: 'Scheduler', testId: 'sidebar-jobs', urlHint: /jobs/i },
    {
        role: 'button',
        name: 'Settings',
        testId: 'sidebar-settings',
        children: [
            { role: 'link', name: 'Platform', testId: 'sidebar-settings-settings', urlHint: /settings/i },
            { role: 'link', name: 'Custom Attributes', testId: 'sidebar-settings-customattributes', urlHint: /customattributes/i },
            { role: 'link', name: 'Global Metadata', testId: 'sidebar-settings-globalmetadata', urlHint: /globalmetadata/i },
            { role: 'link', name: 'Events', testId: 'sidebar-settings-events', urlHint: /events/i },
            { role: 'link', name: 'Logging', testId: 'sidebar-settings-loggingsettings', urlHint: /loggingsettings/i },
            { role: 'link', name: 'Authentication', testId: 'sidebar-settings-authenticationsettings', urlHint: /authenticationsettings/i },
            { role: 'link', name: 'Custom OIDs', testId: 'sidebar-settings-custom-oids', urlHint: /custom-oids/i },
            { role: 'link', name: 'Time Quality', testId: 'sidebar-settings-timequalityconfigurations', urlHint: /timequalityconfigurations/i },
        ],
    },
    { role: 'link', name: 'Audit Logs', testId: 'sidebar-auditlogs', urlHint: /auditlogs/i },
    {
        role: 'button',
        name: 'Workflows',
        testId: 'sidebar-workflows',
        children: [
            { role: 'link', name: 'Rules', testId: 'sidebar-workflows-rules', urlHint: /rules/i },
            { role: 'link', name: 'Actions', testId: 'sidebar-workflows-actions', urlHint: /actions/i },
            { role: 'link', name: 'Triggers', testId: 'sidebar-workflows-triggers', urlHint: /triggers/i },
        ],
    },
] as const;

const collectNavigableItems = (
    items: readonly SidebarItem[],
    parentTestId?: string
): NavigableSidebarItem[] => {
    const results: NavigableSidebarItem[] = [];

    for (const item of items) {
        if (item.role === 'link' && item.urlHint instanceof RegExp) {
            results.push({
                name: item.name,
                testId: item.testId,
                urlHint: item.urlHint,
                parentTestId,
            });
        }

        if (item.role === 'button' && item.children?.length) {
            results.push(...collectNavigableItems(item.children, item.testId));
        }
    }

    return results;
};

export const navigableSidebarItems: readonly NavigableSidebarItem[] =
    collectNavigableItems(sidebarItems);

export const topTilesTitles = [
    'Certificates',
    'Groups',
    'Discoveries',
    'RA Profiles',
] as const;

export const bottomTileTitles = [
    'Certificates by State',
    'Certificates by Validation',
    'Certificates by Compliance',
    'Certificates by Type',
    'Certificates by Expiration in Days',
    'Certificates by Key Size',
    'Certificates by RA Profile',
    'Certificates by Group',
    'Certificates by Subject type',
] as const;
