/** keysOfItemRows — the key search rows are items; a name lookup must see one key per keyWrapperUuid under the key's own name. */
import { expect, test } from '@playwright/test';
import { keysOfItemRows } from '../../utils/regression/ledger/uiCreates';

test('item rows of one key collapse to the key: its name without the item suffix and the keyWrapperUuid', () => {
    const rows = keysOfItemRows([
        { uuid: 'i-1', keyWrapperUuid: 'k-1', name: 'qa-reg-x-key private key', creationTime: 't1' },
        { uuid: 'i-2', keyWrapperUuid: 'k-1', name: 'qa-reg-x-key public key', creationTime: 't1' },
        { uuid: 'i-3', keyWrapperUuid: 'k-2', name: 'qa-reg-x-other secret key' },
    ]);
    expect(rows.map((r) => [r.uuid, r.name])).toEqual([['k-1', 'qa-reg-x-key'], ['k-2', 'qa-reg-x-other']]);
});

test('a row without keyWrapperUuid keeps its own uuid and an unsuffixed name stays as it is', () => {
    expect(keysOfItemRows([{ uuid: 'i-9', name: 'plain' }]).map((r) => [r.uuid, r.name])).toEqual([['i-9', 'plain']]);
});
