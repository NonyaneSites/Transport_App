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
  // Heal typo like "23008/2026"
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
 * Orders debtors within each structure by cancellation date descending.
 * Separates regular cancellations from unaccounted sponsorships and unpaid debt.
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
    const isFTV = nameFTV || (entry.general_notes || '').includes('FTV') || Number(entry.structure_debt) === 20;
    const instanceStr = formatCancellationInstance(entry.date, serviceCode || entry.service) + (isFTV ? ' (FTV)' : '');
    const amount = isFTV ? 20 : (Number(entry.structure_debt) || 40);

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
  }

  const result: StructureDebtSummary[] = [];

  for (const [structure, personMap] of byStructure.entries()) {
    const cancellations: DebtorPersonSummary[] = [];
    const sponsorships: DebtorPersonSummary[] = [];

    for (const [name, data] of personMap.entries()) {
      data.instances.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const latestDate = data.instances[0]?.date || '';

      const summary: DebtorPersonSummary = {
        name,
        structure,
        latestDate,
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
      const dateDiff = (b.latestDate || '').localeCompare(a.latestDate || '');
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
 * Generates and downloads the official CRC Cancellation Debt PDF in the exact format:
 *
 * S1 - (Debt)
 * Person 1 - 23/08/26(AM), 16/08/26(PM)                                                  - R80
 * Person 2 - 23/08/26(AM)                                                                - R40
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
  const margin = 14;
  let y = margin;

  const report = compileDebtReport(entries);
  const grandTotal = report.reduce((sum, s) => sum + s.totalDebt, 0);
  const totalDebtors = report.reduce((sum, s) => sum + s.cancellations.length + s.sponsorships.length, 0);

  const todayStr = new Date().toLocaleDateString('en-ZA', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });

  // --- Header ---
  doc.setFillColor(185, 28, 28); // CRC Crimson (#B91C1C)
  doc.rect(margin, y, pageWidth - margin * 2, 22, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('CRC JOHANNESBURG — TRANSPORT MINISTRY', margin + 4, y + 8);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('2026 SZ CANCELLATION DEBT RECOVERY MANIFEST', margin + 4, y + 14);

  doc.setFontSize(8);
  doc.text(`Generated: ${todayStr} · 2026: The Year of Invasion`, margin + 4, y + 19);

  y += 26;

  // --- Summary Box ---
  doc.setDrawColor(220, 38, 38);
  doc.setFillColor(254, 242, 242);
  doc.roundedRect(margin, y, pageWidth - margin * 2, 11, 2, 2, 'FD');

  doc.setTextColor(185, 28, 28);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(`Total Outstanding Debt: R${grandTotal.toLocaleString()}`, margin + 4, y + 7.5);

  doc.setTextColor(71, 85, 105);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(`Total Debtors: ${totalDebtors}`, pageWidth - margin - 40, y + 7.5);

  y += 15;

  // --- Official Bank & Policy Details ---
  doc.setDrawColor(203, 213, 225);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(margin, y, pageWidth - margin * 2, 28, 2, 2, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(185, 28, 28);
  doc.text('CRC ABSA BANKING DETAILS & SETTLEMENT POLICY', margin + 4, y + 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(51, 65, 85);

  doc.setFont('helvetica', 'bold');
  doc.text('Bank:', margin + 4, y + 11);
  doc.setFont('helvetica', 'normal');
  doc.text(BANK_DETAILS.bank, margin + 14, y + 11);

  doc.setFont('helvetica', 'bold');
  doc.text('Account Name:', margin + 40, y + 11);
  doc.setFont('helvetica', 'normal');
  doc.text(BANK_DETAILS.accountName, margin + 65, y + 11);

  doc.setFont('helvetica', 'bold');
  doc.text('Account Number:', margin + 4, y + 16);
  doc.setFont('helvetica', 'normal');
  doc.text(BANK_DETAILS.accountNumber, margin + 30, y + 16);

  doc.setFont('helvetica', 'bold');
  doc.text('Branch Code:', margin + 60, y + 16);
  doc.setFont('helvetica', 'normal');
  doc.text(BANK_DETAILS.branchCode, margin + 82, y + 16);

  doc.setFont('helvetica', 'bold');
  doc.text('Reference:', margin + 105, y + 16);
  doc.setFont('helvetica', 'normal');
  doc.text('Name + Structure (e.g. John Doe S1)', margin + 122, y + 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(71, 85, 105);
  doc.text(
    '• Unpaid cancellation fees must be settled within 3 weeks. Each structure is collectively liable for its members.',
    margin + 4,
    y + 20.5
  );

  const bulletPrefix = '• Cash may be paid to a transport rep on your next trip. ';
  doc.setTextColor(71, 85, 105);
  doc.setFont('helvetica', 'normal');
  doc.text(bulletPrefix, margin + 4, y + 25);

  const bulletPrefixWidth = doc.getTextWidth(bulletPrefix);
  const popText = 'Upload Proof of Payment (POP): ';
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.text(popText, margin + 4 + bulletPrefixWidth, y + 25);

  const popTextWidth = doc.getTextWidth(popText);
  const linkUrl = 'https://forms.gle/HDvmuZywzNitWFpU6';
  const linkDisplay = 'https://forms.gle/HDvmuZywzNitWFpU6';

  // Make the link prominent Royal Blue and clickable
  doc.setTextColor(29, 78, 216); // Royal Blue (#1D4ED8)
  doc.setFont('helvetica', 'bold');
  doc.textWithLink(linkDisplay, margin + 4 + bulletPrefixWidth + popTextWidth, y + 25, { url: linkUrl });

  // Underline to make it immediately obvious it's interactive
  const linkWidth = doc.getTextWidth(linkDisplay);
  doc.setDrawColor(29, 78, 216);
  doc.setLineWidth(0.25);
  doc.line(
    margin + 4 + bulletPrefixWidth + popTextWidth,
    y + 25.5,
    margin + 4 + bulletPrefixWidth + popTextWidth + linkWidth,
    y + 25.5
  );

  y += 32;

  // --- Debt List Table formatted cleanly ---
  const tableRows: (string | { content: string; styles?: Record<string, unknown>; colSpan?: number })[][] = [];

  for (const structGroup of report) {
    // Structure Section Header without rep info
    const structTitle = structGroup.structure;

    tableRows.push([
      {
        content: structTitle,
        colSpan: 2,
        styles: {
          fillColor: [241, 245, 249],
          textColor: [15, 23, 42],
          fontStyle: 'bold',
          fontSize: 9.5,
          cellPadding: { top: 3.5, bottom: 3.5, left: 4, right: 4 },
        },
      },
      {
        content: `R${structGroup.totalDebt.toLocaleString()}`,
        styles: {
          fillColor: [241, 245, 249],
          textColor: [185, 28, 28],
          fontStyle: 'bold',
          fontSize: 10,
          halign: 'right',
          cellPadding: { top: 3.5, bottom: 3.5, left: 4, right: 4 },
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
          content: `${structTitle} — Unaccounted Sponsorships / Unpaid`,
          colSpan: 2,
          styles: {
            fillColor: [254, 243, 199], // amber-100
            textColor: [146, 64, 14], // amber-800
            fontStyle: 'bold',
            fontSize: 8.5,
            cellPadding: { top: 2.5, bottom: 2.5, left: 4, right: 4 },
          },
        },
        {
          content: `R${structGroup.sponsorshipTotal.toLocaleString()}`,
          styles: {
            fillColor: [254, 243, 199],
            textColor: [185, 28, 28],
            fontStyle: 'bold',
            fontSize: 9,
            halign: 'right',
            cellPadding: { top: 2.5, bottom: 2.5, left: 4, right: 4 },
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

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin, bottom: 16 },
    theme: 'plain',
    head: [['Debtor Name', 'Missed Service Dates & Sessions', 'Amount Owing']],
    body: tableRows as unknown[][],
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8.5,
      cellPadding: 3,
    },
    bodyStyles: {
      fontSize: 8.5,
      textColor: [30, 41, 59],
      cellPadding: 2.5,
      lineColor: [226, 232, 240],
      lineWidth: 0.2,
    },
    columnStyles: {
      0: { cellWidth: 55, fontStyle: 'bold' },
      1: { cellWidth: 'auto', textColor: [71, 85, 105] },
      2: { cellWidth: 30, halign: 'right', fontStyle: 'bold', textColor: [185, 28, 28] },
    },
    didDrawPage: (data) => {
      // Footer on every page
      const pageNumber = data.pageNumber;
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(148, 163, 184);
      doc.text(
        `CRC Johannesburg Transport Ministry · Page ${pageNumber}`,
        margin,
        pageHeight - 8
      );
      doc.text(
        `Total Outstanding: R${grandTotal.toLocaleString()}`,
        pageWidth - margin - 40,
        pageHeight - 8
      );
    },
  });

  doc.save(fileName);
}
