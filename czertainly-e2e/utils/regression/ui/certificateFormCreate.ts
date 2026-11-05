/**
 * certificateFormCreate — the ledger line of a certificate the Add Certificate form created, from the answer's uuid or by run-prefixed
 * common name; written before the spec waits for the redirect, since a page object never writes a ledger line.
 */
import type { CertificateAddPage, FormCreate } from '../../../pages/CertificateAddPage';
import type { CreateAnswer } from '../../../pages/ui/createAnswer';
import type { OwnObjects } from '../ownObjects';

export async function submitFormCreateRecorded(
    form: CertificateAddPage, own: OwnObjects, kind: FormCreate, record: { cn: string; note: string; ra: { uuid: string; authorityUuid: string } },
): Promise<void> {
    let created: CreateAnswer;
    try {
        created = await form.submitCreate(kind);
    } catch (error) {
        await own.recordNamed(record.cn, record.note).catch(() => undefined);
        throw error;
    }
    if (created.uuid) own.record('certificates', created, { name: record.cn, note: record.note, parents: { raProfile: record.ra.uuid, authority: record.ra.authorityUuid } });
    else await own.recordNamed(record.cn, record.note);
}
