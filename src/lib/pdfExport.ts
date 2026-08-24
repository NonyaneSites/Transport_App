import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { type LedgerEntry, BANK_DETAILS } from './ledger';
import { naturalCompare } from './sort';

/**
 * Formats a date and service string into standard cancellation notation:
 * e.g. "2026-08-23" and "AM Service" -> "23/08/26(AM)"
 */
export function formatCancellationInstance(dateStr: string, serviceStr: string): string {
  let d = '01';
  let m = '01';
  let y = '26';

  const cleanDate = (dateStr || '').trim();
  if (cleanDate.includes('-')) {
    const parts = cleanDate.split('-');
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
  } else if (cleanDate.includes('/')) {
    const parts = cleanDate.split('/');
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

  const sLower = (serviceStr || '').toLowerCase();
  const period = sLower.includes('pm') || sLower.includes('evening') || sLower.includes('afternoon') ? 'PM' : 'AM';

  return `${d}/${m}/${y}(${period})`;
}

export interface DebtorPersonSummary {
  name: string;
  structure: string;
  instances: string[]; // e.g. ["23/08/26(AM)", "16/08/26(PM)"]
  totalDebt: number;
}

export interface StructureDebtSummary {
  structure: string;
  totalDebt: number;
  people: DebtorPersonSummary[];
}

/**
 * Groups ledger entries into structures and persons, compiling all missed sessions
 */
export function compileDebtReport(entries: LedgerEntry[]): StructureDebtSummary[] {
  const byStructure = new Map<string, Map<string, { instances: string[]; totalDebt: number }>>();

  for (const entry of entries) {
    const struct = (entry.structure || 'Unassigned Structure').trim();
    const person = (entry.passenger_name || 'Unknown').trim();
    const instanceStr = formatCancellationInstance(entry.date, entry.service);
    const amount = Number(entry.structure_debt) || 40;

    if (!byStructure.has(struct)) {
      byStructure.set(struct, new Map());
    }
    const personMap = byStructure.get(struct)!;

    if (!personMap.has(person)) {
      personMap.set(person, { instances: [], totalDebt: 0 });
    }
    const record = personMap.get(person)!;
    record.instances.push(instanceStr);
    record.totalDebt += amount;
  }

  const result: StructureDebtSummary[] = [];

  for (const [structure, personMap] of byStructure.entries()) {
    const people: DebtorPersonSummary[] = [];
    let structTotal = 0;

    for (const [name, data] of personMap.entries()) {
      people.push({
        name,
        structure,
        instances: data.instances,
        totalDebt: data.totalDebt,
      });
      structTotal += data.totalDebt;
    }

    people.sort((a, b) => naturalCompare(a.name, b.name));

    result.push({
      structure,
      totalDebt: structTotal,
      people,
    });
  }

  result.sort((a, b) => naturalCompare(a.structure, b.structure));
  return result;
}

/**
 * Generates and downloads the official CRC Cancellation Debt PDF in the exact format:
 *
 * S1 - (Debt)
 * Person 1 - 23/08/26(AM), 16/08/26(PM), 16/08/26(AM)                                    - R120
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
  const totalDebtors = report.reduce((sum, s) => sum + s.people.length, 0);

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
    // Structure Section Header row with total debt positioned directly in the Amount Owing column (bold crimson)
    tableRows.push([
      {
        content: structGroup.structure,
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

    // Person rows:
    // Person 1 - 23/08/26(AM), 16/08/26(PM) - R80
    for (const person of structGroup.people) {
      const datesStr = person.instances.join(', ');
      tableRows.push([
        person.name,
        datesStr,
        `R${person.totalDebt.toLocaleString()}`,
      ]);
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
