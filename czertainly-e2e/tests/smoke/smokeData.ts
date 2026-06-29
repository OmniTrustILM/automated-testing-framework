export type SidebarItem = {
    role: 'link' | 'button';
    name: string;
    urlHint?: RegExp;
    children?: readonly SidebarItem[];
};

export type NavigableSidebarItem = {
    name: string;
    urlHint: RegExp;
    parentButtonName?: string;
};

export const sidebarItems: readonly SidebarItem[] = [
    {
        role: 'button',
        name: 'Dashboard',
        children: [
            { role: 'link', name: 'Certificates', urlHint: /\/dashboard\/certificates/i },
            { role: 'link', name: 'Secrets', urlHint: /\/dashboard\/secrets/i },
            { role: 'link', name: 'Signing Records', urlHint: /\/dashboard\/signing-records/i },
        ],
    },
    { role: 'link', name: 'Certificates', urlHint: /\/certificates/i },
    { role: 'link', name: 'Keys', urlHint: /keys/i },
    { role: 'link', name: 'Discoveries', urlHint: /discoveries/i },
    { role: 'link', name: 'Connectors', urlHint: /connectors/i },
    { role: 'link', name: 'Secrets', urlHint: /\/secrets/i },
    { role: 'link', name: 'CBOMs', urlHint: /\/cboms/i },
    { role: 'link', name: 'Signing Records', urlHint: /\/signingrecords/i },
    {
        role: 'button',
        name: 'Access Control',
        children: [
            { role: 'link', name: 'Users', urlHint: /users/i },
            { role: 'link', name: 'Roles', urlHint: /roles/i },
        ],
    },
    {
        role: 'button',
        name: 'Profiles',
        children: [
            { role: 'link', name: 'RA Profiles', urlHint: /raprofiles/i },
            { role: 'link', name: 'Token Profiles', urlHint: /tokenprofiles/i },
            { role: 'link', name: 'Compliance Profiles', urlHint: /complianceprofiles/i },
            { role: 'link', name: 'Notification Profiles', urlHint: /notificationprofiles/i },
            { role: 'link', name: 'Vault Profiles', urlHint: /vaultprofiles/i },
            { role: 'link', name: 'Signing Profiles', urlHint: /signingprofiles/i },
        ],
    },
    {
        role: 'button',
        name: 'Inventory',
        children: [
            { role: 'link', name: 'Credentials', urlHint: /credentials/i },
            { role: 'link', name: 'Authorities', urlHint: /authorities/i },
            { role: 'link', name: 'Tokens', urlHint: /tokens/i },
            { role: 'link', name: 'Groups', urlHint: /groups/i },
            { role: 'link', name: 'Entities', urlHint: /entities/i },
            { role: 'link', name: 'Locations', urlHint: /locations/i },
            { role: 'link', name: 'Vaults', urlHint: /\/vaults/i },
        ],
    },
    {
        role: 'button',
        name: 'Protocols',
        children: [
            { role: 'link', name: 'ACME Accounts', urlHint: /acmeaccounts/i },
            { role: 'link', name: 'ACME Profiles', urlHint: /acmeprofiles/i },
            { role: 'link', name: 'CMP Profiles', urlHint: /cmpprofiles/i },
            { role: 'link', name: 'SCEP Profiles', urlHint: /scepprofiles/i },
            { role: 'link', name: 'TSP Profiles', urlHint: /tspprofiles/i },
        ],
    },
    {
        role: 'button',
        name: 'Approvals',
        children: [
            { role: 'link', name: 'Approval Profiles', urlHint: /approvalprofiles/i },
            { role: 'link', name: 'Approval List', urlHint: /approvals/i },
        ],
    },
    { role: 'link', name: 'Scheduler', urlHint: /jobs/i },
    {
        role: 'button',
        name: 'Settings',
        children: [
            { role: 'link', name: 'Platform', urlHint: /settings/i },
            { role: 'link', name: 'Custom Attributes', urlHint: /customattributes/i },
            { role: 'link', name: 'Global Metadata', urlHint: /globalmetadata/i },
            { role: 'link', name: 'Events', urlHint: /events/i },
            { role: 'link', name: 'Logging', urlHint: /loggingsettings/i },
            { role: 'link', name: 'Authentication', urlHint: /authenticationsettings/i },
            { role: 'link', name: 'Custom OIDs', urlHint: /custom-oids/i },
            { role: 'link', name: 'Time Quality', urlHint: /timequalityconfigurations/i },
        ],
    },
    { role: 'link', name: 'Audit Logs', urlHint: /auditlogs/i },
    {
        role: 'button',
        name: 'Workflows',
        children: [
            { role: 'link', name: 'Rules', urlHint: /rules/i },
            { role: 'link', name: 'Actions', urlHint: /actions/i },
            { role: 'link', name: 'Triggers', urlHint: /triggers/i },
        ],
    },
] as const;

const collectNavigableItems = (
    items: readonly SidebarItem[],
    parentButtonName?: string
): NavigableSidebarItem[] => {
    const results: NavigableSidebarItem[] = [];

    for (const item of items) {
        if (item.role === 'link' && item.urlHint instanceof RegExp) {
            results.push({
                name: item.name,
                urlHint: item.urlHint,
                parentButtonName,
            });
        }

        if (item.role === 'button' && item.children?.length) {
            results.push(...collectNavigableItems(item.children, item.name));
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
