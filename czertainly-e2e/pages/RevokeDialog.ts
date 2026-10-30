/**
 * RevokeDialog — the "Revoke Certificate" dialog (REG-CERT-10).
 *
 * A `CertificateToolbarDialog`: the reason select and submit. The reasons are read from the open option list (the
 * placeholder is not a reason). The status goes back to the spec.
 */
import { expect, Locator, Page } from '@playwright/test';
import { ApiAnswer } from '../utils/regression/apiReads';
import { CertificateToolbarDialog } from './CertificateToolbarDialog';
import { chooseOption, readSelectOptions } from './ui/select';
import { UUID } from './ui/waitForResponse';

/** The placeholder option of a Select ("Choose …"): shown in the list, but not a value. */
const PLACEHOLDER_OPTION = /^choose\b/i;

export class RevokeDialog extends CertificateToolbarDialog {
    readonly reasonTrigger: Locator;
    readonly submitButton: Locator;

    constructor(page: Page) {
        super(page, 'Revoke Certificate', 'revoke');
        this.reasonTrigger = this.dialog.getByTestId('select-revokeReason-trigger');
        this.submitButton = this.dialog.getByTestId('revokeSubmit');
    }

    /**
     * The reason labels the dialog offers, in the order shown (the option list is opened, read and closed). A
     * placeholder option ("Choose …") is not a reason and is skipped.
     */
    async reasonLabels(): Promise<string[]> {
        return (await readSelectOptions(this.page, this.reasonTrigger)).filter((label) => !PLACEHOLDER_OPTION.test(label));
    }

    /** The dialog offers exactly these labels (order-insensitive, no extras). */
    async assertReasons(expected: readonly string[]): Promise<void> {
        const shown = await this.reasonLabels();
        expect([...shown].sort(), 'revoke reasons').toEqual([...expected].sort());
    }

    async chooseReason(label: string): Promise<void> {
        await chooseOption(this.page, this.reasonTrigger, label);
    }

    /** Submit; returns the answer of `POST …/revoke` (204). */
    async submit(): Promise<ApiAnswer> {
        return this.answerWithUuid({ method: 'POST', path: new RegExp(`/certificates/${UUID}/revoke$`) }, () => this.submitButton.click());
    }
}
