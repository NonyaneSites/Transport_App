import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { type LedgerEntry, BANK_DETAILS, extractServiceCode, extractNameAndService } from './ledger';
import { naturalCompare } from './sort';

/**
 * Formats a date and service string into standard cancellation notation:
 * e.g. "2026-08-23" and "AM" -> "23/08/26(AM)"
 * e.g. "2026-07-27" and "LM" -> "27/07/26(LM)"
 * e.g. "2026-08-08" and "WMP" -> "08/08/26(WMP)"
 * e.g. "2026-04-03" and "EF" -> "03/04/26(EF)"
 * e.g. "2026-05-14" and "AD" -> "14/05/26(AD)"
 */
export function formatCancellationInstance(dateStr: string, serviceStr: string): string {
  let d = '01';
  let m = '01';
  let y = '26';

  const cleanDate = (dateStr || '').trim().replace(/\s+/g, '');
  // Heal typos like "23008/2026" or "2308/2026"
  const fixedDate = cleanDate.replace(/^(\d{1,2})0+(\d{1,2})\//, '$1/$2/');

  if (fixedDate.includes('-')) {
    const parts = fixedDate.split('-');
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        y = parts[0].slice(2);
        m = parts[1].padStart(2, '0');
        d = parts[2].padStart(2, '0');
      } else {
        d = parts[0].padStart(2, '0');
        m = parts[1].padStart(2, '0');
        y = parts[2].length === 4 ? parts[2].slice(2) : parts[2];
      }
    }
  } else if (fixedDate.includes('/')) {
    const parts = fixedDate.split('/');
    if (parts.length === 3) {
      if (parts[2].length === 4) {
        d = parts[0].padStart(2, '0');
        m = parts[1].padStart(2, '0');
        y = parts[2].slice(2);
      } else if (parts[0].length === 4) {
        y = parts[0].slice(2);
        m = parts[1].padStart(2, '0');
        d = parts[2].padStart(2, '0');
      } else {
        d = parts[0].padStart(2, '0');
        m = parts[1].padStart(2, '0');
        y = parts[2];
      }
    }
  }

  const code = extractServiceCode(serviceStr) || 'PM';
  return `${d}/${m}/${y}(${code})`;
}

export interface DebtorPersonSummary {
  name: string;
  structure: string;
  latestDate: string;
  instances: string[]; // e.g. ["23/08/26(AM)", "16/08/26(PM)"]
  totalDebt: number;
  isSponsorshipOrUnpaid: boolean;
  notes: string;
}

export interface StructureDebtSummary {
  structure: string;
  cancellationTotal: number;
  sponsorshipTotal: number;
  totalDebt: number;
  cancellations: DebtorPersonSummary[];
  sponsorships: DebtorPersonSummary[];
}

/**
 * Groups ledger entries into structures and persons, compiling all missed sessions
 * while accurately preserving individual church event service codes (AM, PM, LM, WMP, EF, AD, FW).
 * Ensures all sponsorships & unpaid items across all structures (S1, S3, S5, S6, S10, S16, S20, S26, etc.)
 * are accurately parsed, attributed, and totaled.
 */
export function compileDebtReport(entries: LedgerEntry[]): StructureDebtSummary[] {
  const byStructure = new Map<
    string,
    Map<string, { instances: { date: string; formatted: string }[]; totalDebt: number; isSponsorship: boolean; notes: string }>
  >();

  for (const entry of entries) {
    const struct = (entry.structure || 'Unassigned Structure').trim();
    const { cleanName, serviceCode, isFTV: nameFTV } = extractNameAndService(entry.passenger_name, entry.service);
    const person = cleanName || entry.passenger_name || 'Unknown';
    const isFTV = nameFTV || (entry.general_notes || '').includes('FTV') || (entry.sponsor_note || '').includes('FTV');
    const instanceStr = formatCancellationInstance(entry.date, serviceCode || entry.service) + (isFTV ? ' (FTV)' : '');
    const rawDebt = Number(entry.structure_debt);
    const amount = Number.isFinite(rawDebt) && rawDebt >= 0 ? rawDebt : 40;

    const gn = (entry.general_notes || '').toLowerCase();
    const sn = (entry.sponsor_note || '').toLowerCase();
    const isSponsorship =
      entry.sponsored ||
      gn.includes('unaccounted') ||
      gn.includes('unpaid') ||
      gn.includes('did not pay') ||
      gn.includes('sponsorship') ||
      sn.includes('unaccounted') ||
      sn.includes('unpaid') ||
      sn.includes('sponsorship');

    if (!byStructure.has(struct)) {
      byStructure.set(struct, new Map());
    }
    const structMap = byStructure.get(struct)!;

    if (!structMap.has(person)) {
      structMap.set(person, {
        instances: [],
        totalDebt: 0,
        isSponsorship,
        notes: entry.general_notes || entry.sponsor_note || '',
      });
    }
    const record = structMap.get(person)!;
    record.instances.push({ date: entry.date, formatted: instanceStr });
    record.totalDebt += amount;
    if (isSponsorship) record.isSponsorship = true;
    if (!record.notes && (entry.general_notes || entry.sponsor_note)) {
      record.notes = entry.general_notes || entry.sponsor_note || '';
    }
  }

  const result: StructureDebtSummary[] = [];

  for (const [structure, personMap] of byStructure.entries()) {
    const cancellations: DebtorPersonSummary[] = [];
    const sponsorships: DebtorPersonSummary[] = [];

    for (const [name, data] of personMap.entries()) {
      data.instances.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const earliestDate = data.instances[0]?.date || '';

      const summary: DebtorPersonSummary = {
        name,
        structure,
        latestDate: earliestDate,
        instances: data.instances.map((i) => i.formatted),
        totalDebt: data.totalDebt,
        isSponsorshipOrUnpaid: data.isSponsorship,
        notes: data.notes,
      };

      if (data.isSponsorship) {
        sponsorships.push(summary);
      } else {
        cancellations.push(summary);
      }
    }

    const sortFn = (a: DebtorPersonSummary, b: DebtorPersonSummary) => {
      if (b.totalDebt !== a.totalDebt) {
        return b.totalDebt - a.totalDebt;
      }
      const dateDiff = (a.latestDate || '').localeCompare(b.latestDate || '');
      if (dateDiff !== 0) return dateDiff;
      return naturalCompare(a.name, b.name);
    };

    cancellations.sort(sortFn);
    sponsorships.sort(sortFn);

    const cancellationTotal = cancellations.reduce((s, p) => s + p.totalDebt, 0);
    const sponsorshipTotal = sponsorships.reduce((s, p) => s + p.totalDebt, 0);

    result.push({
      structure,
      cancellationTotal,
      sponsorshipTotal,
      totalDebt: cancellationTotal + sponsorshipTotal,
      cancellations,
      sponsorships,
    });
  }

  result.sort((a, b) => naturalCompare(a.structure, b.structure));
  return result;
}

/**
 * Generates and downloads the official CRC Cancellation Debt PDF in a compact 5-page layout.
 *
 * Page Geometry:
 * - Margins: left: 10mm, right: 10mm, top: 14mm, bottom: 12mm
 * - Compact typography (8pt body, 9pt bold structure banners, 2.5/4 cell padding)
 * - Alternating row background fills (#F9FAFB and #FFFFFF)
 * - Col 1 (Name): ~45mm
 * - Col 2 (Missed Dates & Sessions): ~115mm
 * - Col 3 (Amount Owing): ~25mm
 */
export function downloadCancellationDebtPdf(
  entries: LedgerEntry[],
  fileName: string = `CRC_Cancellation_Debt_List_${new Date().toISOString().slice(0, 10)}.pdf`
): void {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const leftMargin = 10;
  const rightMargin = 10;
  const topMargin = 14;
  const bottomMargin = 12;
  const usableWidth = pageWidth - leftMargin - rightMargin;

  let y = topMargin;

  const report = compileDebtReport(entries);
  const grandTotal = report.reduce((sum, s) => sum + s.totalDebt, 0);
  const totalDebtors = report.reduce((sum, s) => sum + s.cancellations.length + s.sponsorships.length, 0);

  const todayStr = new Date().toLocaleDateString('en-ZA', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });

  // --- Page 1 Compact Header Banner ---
  doc.setFillColor(185, 28, 28); // CRC Crimson (#B91C1C)
  doc.rect(leftMargin, y, usableWidth, 14, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('CRC JOHANNESBURG — TRANSPORT MINISTRY', leftMargin + 3.5, y + 5.5);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(`2026 SZ CANCELLATION DEBT RECOVERY MANIFEST · Generated: ${todayStr}`, leftMargin + 3.5, y + 10.5);

  // Total Outstanding on Top Right of Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text(`Total: R${grandTotal.toLocaleString()}`, pageWidth - rightMargin - 3.5, y + 8, { align: 'right' });

  y += 16;

  // --- Compact Settlement & Banking Bar ---
  doc.setDrawColor(203, 213, 225);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(leftMargin, y, usableWidth, 15, 1.5, 1.5, 'FD');

  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(185, 28, 28);
  doc.text('ABSA BANKING DETAILS:', leftMargin + 3, y + 4.5);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(30, 41, 59);
  doc.text(
    `Acc: ${BANK_DETAILS.accountName} | Bank: ${BANK_DETAILS.bank} | Acc #: ${BANK_DETAILS.accountNumber} | Branch: ${BANK_DETAILS.branchCode} | Ref: Name + Structure`,
    leftMargin + 38,
    y + 4.5
  );

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(71, 85, 105);
  doc.text('• Fees must be settled within 3 weeks. Cash accepted by Rep. Upload POP to:', leftMargin + 3, y + 10);

  const popPrefixWidth = doc.getTextWidth('• Fees must be settled within 3 weeks. Cash accepted by Rep. Upload POP to: ');
  const linkUrl = 'https://forms.gle/HDvmuZywzNitWFpU6';
  doc.setTextColor(29, 78, 216); // Royal Blue
  doc.setFont('helvetica', 'bold');
  doc.textWithLink(linkUrl, leftMargin + 3 + popPrefixWidth, y + 10, { url: linkUrl });

  y += 18;

  // --- Table Rows Compilation ---
  const tableRows: (string | { content: string; styles?: Record<string, unknown>; colSpan?: number })[][] = [];

  for (const structGroup of report) {
    const structTitle = structGroup.structure;

    // Compact Structure Banner
    tableRows.push([
      {
        content: `${structTitle} — Total Outstanding: R${structGroup.totalDebt.toLocaleString()}`,
        colSpan: 2,
        styles: {
          fillColor: [226, 232, 240], // slate-200
          textColor: [15, 23, 42],
          fontStyle: 'bold',
          fontSize: 9,
          cellPadding: { top: 2.2, bottom: 2.2, left: 3.5, right: 3.5 },
        },
      },
      {
        content: `R${structGroup.totalDebt.toLocaleString()}`,
        styles: {
          fillColor: [226, 232, 240],
          textColor: [185, 28, 28],
          fontStyle: 'bold',
          fontSize: 9,
          halign: 'right',
          cellPadding: { top: 2.2, bottom: 2.2, left: 3.5, right: 3.5 },
        },
      },
    ]);

    // 1. Regular Cancellations
    for (const person of structGroup.cancellations) {
      const datesStr = person.instances.join(', ');
      tableRows.push([
        person.name,
        datesStr,
        `R${person.totalDebt.toLocaleString()}`,
      ]);
    }

    // 2. Unaccounted Sponsorships & Unpaid
    if (structGroup.sponsorships.length > 0) {
      tableRows.push([
        {
          content: `${structTitle} — Unaccounted Sponsorships / Unpaid (R${structGroup.sponsorshipTotal.toLocaleString()})`,
          colSpan: 2,
          styles: {
            fillColor: [254, 243, 199], // amber-100
            textColor: [146, 64, 14], // amber-800
            fontStyle: 'bold',
            fontSize: 8,
            cellPadding: { top: 1.8, bottom: 1.8, left: 3.5, right: 3.5 },
          },
        },
        {
          content: `R${structGroup.sponsorshipTotal.toLocaleString()}`,
          styles: {
            fillColor: [254, 243, 199],
            textColor: [185, 28, 28],
            fontStyle: 'bold',
            fontSize: 8,
            halign: 'right',
            cellPadding: { top: 1.8, bottom: 1.8, left: 3.5, right: 3.5 },
          },
        },
      ]);

      for (const person of structGroup.sponsorships) {
        const datesStr = person.instances.join(', ');
        const label = person.notes ? `${person.name} (${person.notes})` : person.name;
        tableRows.push([
          label,
          datesStr,
          `R${person.totalDebt.toLocaleString()}`,
        ]);
      }
    }
  }

  // --- Render High-Density AutoTable ---
  autoTable(doc, {
    startY: y,
    margin: { left: leftMargin, right: rightMargin, top: topMargin, bottom: bottomMargin },
    theme: 'striped',
    head: [['Debtor Name', 'Missed Dates & Sessions', 'Amount Owing']],
    body: tableRows as unknown[][],
    headStyles: {
      fillColor: [30, 41, 59], // slate-800
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8.5,
      cellPadding: { top: 2.5, bottom: 2.5, left: 3.5, right: 3.5 },
    },
    bodyStyles: {
      fontSize: 8,
      textColor: [15, 23, 42],
      cellPadding: { top: 2.2, bottom: 2.2, left: 3.5, right: 3.5 },
      lineColor: [226, 232, 240],
      lineWidth: 0.15,
    },
    alternateRowStyles: {
      fillColor: [249, 250, 251], // #F9FAFB
    },
    columnStyles: {
      0: { cellWidth: 46, fontStyle: 'bold' },
      1: { cellWidth: 114, textColor: [51, 65, 85] },
      2: { cellWidth: 26, halign: 'right', fontStyle: 'bold', textColor: [185, 28, 28] },
    },
    didDrawPage: (data) => {
      // 1-line Running Header (Pages 2+)
      if (data.pageNumber > 1) {
        doc.setFontSize(7.5);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(185, 28, 28);
        doc.text('CRC JOHANNESBURG — 2026 CANCELLATION DEBT MANIFEST', leftMargin, topMargin - 4);

        doc.setFont('helvetica', 'normal');
        doc.setTextColor(100, 116, 139);
        doc.text(`Total Outstanding: R${grandTotal.toLocaleString()}`, pageWidth - rightMargin, topMargin - 4, { align: 'right' });

        doc.setDrawColor(226, 232, 240);
        doc.setLineWidth(0.2);
        doc.line(leftMargin, topMargin - 2.5, pageWidth - rightMargin, topMargin - 2.5);
      }

      // 1-line Running Footer (All Pages)
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(148, 163, 184);
      doc.text(
        `CRC Transport Ministry · Total Debtors: ${totalDebtors} · Total Outstanding: R${grandTotal.toLocaleString()}`,
        leftMargin,
        pageHeight - 6
      );
      doc.text(
        `Page ${data.pageNumber}`,
        pageWidth - rightMargin,
        pageHeight - 6,
        { align: 'right' }
      );
    },
  });

  doc.save(fileName);
}
