// Writes the TSA certificate profiles and the TSA end-entity profile as EJBCA import XML,
// serialized by EJBCA's own classes so every field has its default.
import java.beans.XMLEncoder;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import org.cesecore.certificates.certificate.CertificateConstants;
import org.cesecore.certificates.certificateprofile.CertificateProfile;
import org.cesecore.certificates.certificateprofile.CertificateProfileConstants;
import org.ejbca.core.model.ra.raadmin.EndEntityProfile;

public class MkProf {
    static void write(Object data, String file) throws Exception {
        try (XMLEncoder e = new XMLEncoder(new FileOutputStream(file))) { e.writeObject(data); }
    }
    static CertificateProfile tsa(boolean qualified) throws Exception {
        CertificateProfile p = new CertificateProfile(CertificateProfileConstants.CERTPROFILE_FIXED_ENDUSER);
        p.setKeyUsage(new boolean[9]);
        p.setKeyUsage(CertificateConstants.DIGITALSIGNATURE, true);
        p.setKeyUsageCritical(true);
        p.setUseExtendedKeyUsage(true);
        p.setExtendedKeyUsageOids(new ArrayList<>(List.of("1.3.6.1.5.5.7.3.8")));
        p.setExtendedKeyUsageCritical(true);
        p.setAvailableCAs(new ArrayList<>(List.of(CertificateProfile.ANYCA)));
        if (qualified) {
            p.setUseQCStatement(true);
            p.setUseQCEtsiQCCompliance(true);
            p.setUseQCEtsiSignatureDevice(true);
        }
        return p;
    }
    public static void main(String[] a) throws Exception {
        String dir = a[0];
        write(tsa(false).saveData(), dir + "/certprofile_DemoTSAEECertificateProfile-70001.xml");
        write(tsa(true).saveData(), dir + "/certprofile_DemoTSAQCEECertificateProfile-70002.xml");
        EndEntityProfile ee = new EndEntityProfile(true);
        ee.setAvailableCertificateProfileIds(List.of(70001, 70002));
        ee.setDefaultCertificateProfile(70001);
        ee.setAvailableCAs(List.of(1));
        write(ee.saveData(), dir + "/entityprofile_DemoTSAEndEntityProfile-70003.xml");
    }
}
