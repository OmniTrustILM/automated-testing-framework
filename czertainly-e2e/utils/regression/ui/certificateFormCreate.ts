/**
 * certificateFormCreate — the ledger line of a certificate the Add Certificate form created.
 *
 * `submitFormCreateRecorded` clicks Create (Issue now or Pre-register) and writes the `created` line from the answer's uuid,
 * or by run-prefixed common name when the answer names no object or never arrives. The certificate is on the tier once the
 * platform accepts the request, so the line must exist before the spec waits for the redirect or asserts anything.
 * A page object never writes a ledger line, so the step lives here.
 */
import type { CertificateAddPage, FormCreate } from '../../../pages/CertificateAddPage';
import type { CreateAnswer } from '../../../pages/ui/createAnswer';
import type { OwnObjects } from '../ownObjects';

/** Clicks Create and records what the form created before anything waits for the redirect (see the module header). */
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
