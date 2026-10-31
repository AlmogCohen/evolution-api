import { BinaryNode, getBinaryNodeChild, proto } from 'baileys';

/**
 * The usync `business` protocol, asking for `verified_name`: the name WhatsApp
 * certifies for a WhatsApp Business account, which its own clients show for a
 * business that is not in the address book. Baileys 7.0.0-rc14 has no such
 * protocol. The answer is a VerifiedNameCertificate, the same one a live
 * message carries in its `verified_name` node (decode-wa-message.js).
 */
export class USyncVerifiedNameProtocol {
  name = 'business';

  getQueryElement(): BinaryNode {
    return { tag: 'business', attrs: {}, content: [{ tag: 'verified_name', attrs: {} }] };
  }

  getUserElement(): BinaryNode | null {
    return null;
  }

  parser(node: BinaryNode): { verifiedName: string | null } {
    const certificate = getBinaryNodeChild(node, 'verified_name')?.content;
    if (!(certificate instanceof Uint8Array)) return { verifiedName: null };
    const cert = proto.VerifiedNameCertificate.decode(certificate);
    const details = proto.VerifiedNameCertificate.Details.decode(cert.details);
    return { verifiedName: details.verifiedName || null };
  }
}
