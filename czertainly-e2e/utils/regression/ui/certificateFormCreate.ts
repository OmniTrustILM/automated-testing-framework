/**
 * certificateFormCreate — the ledger line of a certificate the Add Certificate form created.
 *
 * WHAT: `submitFormCreateRecorded(form, own, kind, { cn, note, ra })` clicks Create on the form (Issue now or Pre-register) and writes the
 *       `created` ledger line from the answer's uuid, or by run-prefixed common name when the answer names no object or never arrives.
 * WHY: the certificate is on the tier from the moment the platform accepts the request, so its line must exist before the spec waits
 *      for the redirect or asserts anything; a timeout after a successful create must not leave a certificate the teardown cannot
 *      name. A page object never writes a ledger line, so the step lives here, next to the other ledger helpers.
 * HOW: `form.submitCreate` returns the answer (wait registered before the click); when it throws, every run-named certificate of the
 *      common name is recorded and the error continues. A refused answer that carries a uuid is recorded by `own.record`, which then
 *      throws. The spec calls `form.waitForCreatedCertificate` afterwards.
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
