import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2, AlertTriangle, FileSpreadsheet, Search, Filter, XCircle,
  ChevronDown, ChevronRight, Upload, CheckCircle2, FileText, Banknote, X, UserPlus, Plus,
  Pencil, Trash2, HeartHandshake, Clock,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { connectSyncEvents } from '@/lib/serverApi';
import {
  listLedgerEntries, deleteLedgerEntry, downloadLedgerExcel,
  aggregateLedgerEntries, parseHistoricalCancellationWorkbook, importHistoricalCancellations,
  recordPartialPayment, addManualLedgerEntry, evaluateLedgerSearch,
  updateDebtorWithInstances, normalizeDateToYMD, normalizeStructureCode, structureSortComparator,
  listReportedSponsorships, verifySponsorshipStatus, groupSponsorshipsByStructure, sanitizePassengerDisplayName,
  type DebtorInstanceUpdateItem,
  type LedgerEntry, type AggregatedLedgerRow, type HistoricalImportResult,
  type ReportedSponsorship, type SponsorshipStatus,
} from '@/lib/ledger';
import { downloadCancellationDebtPdf } from '@/lib/pdfExport';

function HighlightMatch({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q || !text) return <span>{text}</span>;

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);

  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="bg-crimson-500/30 text-crimson-200 font-bold px-0.5 rounded">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

export function LedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [structureFilter, setStructureFilter] = useState('');
  const [openStructures, setOpenStructures] = useState<Set<string>>(new Set());

  // Partial Payment Modal State
  const [paymentTarget, setPaymentTarget] = useState<AggregatedLedgerRow | null>(null);
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  // Edit Debtor Modal State
  const [editTarget, setEditTarget] = useState<AggregatedLedgerRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editStructure, setEditStructure] = useState('');
  const [editDebt, setEditDebt] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editIsSponsored, setEditIsSponsored] = useState(false);
  const [editDebtType, setEditDebtType] = useState<'cancellation' | 'unaccounted_sponsorship' | 'unpaid_sponsorship'>('cancellation');
  const [editInstances, setEditInstances] = useState<DebtorInstanceUpdateItem[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingDebtor, setDeletingDebtor] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSuccessMessage, setEditSuccessMessage] = useState<string | null>(null);

  // Manual Add Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [addFirstName, setAddFirstName] = useState('');
  const [addSurname, setAddSurname] = useState('');
  const [addStructure, setAddStructure] = useState('S1');
  const [addService, setAddService] = useState('PM');
  const [addAmount, setAddAmount] = useState('40');
  const [addDate, setAddDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [addNotes, setAddNotes] = useState('');
  const [addIsSponsored, setAddIsSponsored] = useState(false);
  const [addDebtType, setAddDebtType] = useState<'cancellation' | 'unaccounted_sponsorship' | 'unpaid_sponsorship'>('cancellation');
  const [addingDebtor, setAddingDebtor] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccessMessage, setAddSuccessMessage] = useState<string | null>(null);

  // Top Tab State: Cancellations & Debtors vs Reported Sponsorships
  const [activeTab, setActiveTab] = useState<'cancellations' | 'sponsorships'>(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#sponsorships') {
      return 'sponsorships';
    }
    return 'cancellations';
  });

  // Reported Sponsorships Audit State
  const [sponsorships, setSponsorships] = useState<ReportedSponsorship[]>([]);
  const [sponsorshipFilter, setSponsorshipFilter] = useState<'pending' | 'actually_sponsored' | 'debt' | 'all'>('pending');
  const [closedSponsorshipStructures, setClosedSponsorshipStructures] = useState<Set<string>>(new Set());
  const [sponsorshipUpdatingId, setSponsorshipUpdatingId] = useState<string | null>(null);
  const [sponsorshipNotice, setSponsorshipNotice] = useState<{ id: string; text: string; type: 'success' | 'warn' } | null>(null);

  // Historical Cancellation Import
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<HistoricalImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importFileName, setImportFileName] = useState<string | null>(null);

  useEffect(() => {
    const handleHashChange = () => {
      if (window.location.hash === '#sponsorships') {
        setActiveTab('sponsorships');
      } else {
        setActiveTab('cancellations');
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [data, sponData] = await Promise.all([
          listLedgerEntries(),
          listReportedSponsorships(),
        ]);
        if (mounted) {
          setEntries(data);
          setSponsorships(sponData);
          setLoading(false);
        }
      } catch (e) {
        if (mounted) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();

    const disconnectSSE = connectSyncEvents(
      undefined,
      async () => {
        if (mounted) {
          const refreshed = await listLedgerEntries();
          setEntries(refreshed);
        }
      },
      undefined,
      async () => {
        if (mounted) {
          const sponRefreshed = await listReportedSponsorships();
          setSponsorships(sponRefreshed);
        }
      }
    );

    return () => {
      mounted = false;
      disconnectSSE();
    };
  }, []);

  const structures = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => {
      if (e.structure) set.add(normalizeStructureCode(e.structure));
    });
    sponsorships.forEach((s) => {
      if (s.structure) set.add(normalizeStructureCode(s.structure));
    });
    return Array.from(set).sort(structureSortComparator);
  }, [entries, sponsorships]);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q && !structureFilter) return entries;

    return entries.filter((e) => {
      const struct = normalizeStructureCode(e.structure);
      if (structureFilter && struct !== structureFilter) return false;
      if (!q) return true;
      const { matched } = evaluateLedgerSearch(
        {
          passenger_name: e.passenger_name,
          structure: struct,
          general_notes: e.general_notes,
          sponsor_note: e.sponsor_note,
          date: e.date,
          service: e.service,
        },
        q
      );
      return matched;
    });
  }, [entries, search, structureFilter]);

  const totalDebt = filtered.reduce((sum, e) => sum + Number(e.structure_debt), 0);

  const sponsorshipStats = useMemo(() => {
    const total = sponsorships.length;
    const pending = sponsorships.filter((s) => s.status === 'pending').length;
    const confirmed = sponsorships.filter((s) => s.status === 'actually_sponsored').length;
    const debt = sponsorships.filter((s) => s.status === 'unaccounted_sponsorship' || s.status === 'unpaid_sponsorship').length;
    return { total, pending, confirmed, debt };
  }, [sponsorships]);

  const filteredSponsorships = useMemo(() => {
    let list = sponsorships.map((s) => ({
      ...s,
      passenger_name: sanitizePassengerDisplayName(s.passenger_name),
      structure: normalizeStructureCode(s.structure),
    }));

    if (structureFilter) {
      list = list.filter((s) => s.structure === structureFilter);
    }
    if (sponsorshipFilter === 'pending') {
      list = list.filter((s) => s.status === 'pending');
    } else if (sponsorshipFilter === 'actually_sponsored') {
      list = list.filter((s) => s.status === 'actually_sponsored');
    } else if (sponsorshipFilter === 'debt') {
      list = list.filter((s) => s.status === 'unaccounted_sponsorship' || s.status === 'unpaid_sponsorship');
    }

    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        s.passenger_name.toLowerCase().includes(q) ||
        s.structure.toLowerCase().includes(q) ||
        s.vehicle_name.toLowerCase().includes(q) ||
        s.sponsor_note.toLowerCase().includes(q) ||
        s.rep_name.toLowerCase().includes(q) ||
        (s.stop || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [sponsorships, structureFilter, sponsorshipFilter, search]);

  const groupedSponsorships = useMemo(() => {
    return groupSponsorshipsByStructure(filteredSponsorships);
  }, [filteredSponsorships]);

  // Shared with the download (see aggregateLedgerEntries in lib/ledger) so
  // the web view and the exported "SZ Cancellation List" never drift apart.
  const groupedByStructure = useMemo(() => {
    const groups = aggregateLedgerEntries(filtered);
    const q = search.trim();
    if (!q) return groups;

    // When searching, sort the aggregated rows within each structure by search score
    // so prefix matches (e.g. names starting with "amo") appear at the top
    return groups.map((g) => {
      const scoreMap = new Map<string, number>();
      for (const row of g.rows) {
        const { score } = evaluateLedgerSearch(
          {
            name: row.name,
            structure: row.structure,
            notes: row.notes,
            formattedDateList: row.formattedDateList,
            serviceCodes: row.serviceCodes,
          },
          q
        );
        scoreMap.set(row.key, score);
      }

      const sortRows = (rows: AggregatedLedgerRow[]) =>
        [...rows].sort((a, b) => {
          const scoreA = scoreMap.get(a.key) ?? 0;
          const scoreB = scoreMap.get(b.key) ?? 0;
          if (scoreB !== scoreA) return scoreB - scoreA;
          return b.amount - a.amount;
        });

      return {
        ...g,
        rows: sortRows(g.rows),
        cancellationRows: sortRows(g.cancellationRows),
        sponsorshipRows: sortRows(g.sponsorshipRows),
      };
    });
  }, [filtered, search]);

  async function handleImportFile(file: File) {
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    setImportFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const result = parseHistoricalCancellationWorkbook(buf);
      if (result.rows.length > 0) {
        await importHistoricalCancellations(result.rows);
        const refreshed = await listLedgerEntries();
        setEntries(refreshed);
      }
      setImportResult(result);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  function onImportInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleImportFile(file);
    e.target.value = '';
  }

  function toggleStructure(s: string) {
    setOpenStructures((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function expandAllStructures() {
    setOpenStructures(new Set(groupedByStructure.map((g) => g.structure)));
  }

  function collapseAllStructures() {
    setOpenStructures(new Set());
  }

  function toggleSponsorshipStructure(s: string) {
    setClosedSponsorshipStructures((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function isSponsorshipStructureOpen(s: string) {
    if (search.trim()) return true;
    return !closedSponsorshipStructures.has(s);
  }

  function expandAllSponsorshipStructures() {
    setClosedSponsorshipStructures(new Set());
  }

  function collapseAllSponsorshipStructures() {
    setClosedSponsorshipStructures(new Set(groupedSponsorships.map((g) => g.structure)));
  }

  function openPaymentModal(row: AggregatedLedgerRow) {
    setPaymentTarget(row);
    setPaymentAmount(String(row.amount));
    setPaymentError(null);
  }

  function closePaymentModal() {
    setPaymentTarget(null);
    setPaymentAmount('');
    setPaymentError(null);
  }

  function openEditModal(row: AggregatedLedgerRow) {
    setEditTarget(row);
    setEditName(row.name);
    setEditStructure(normalizeStructureCode(row.structure));
    setEditDebt(String(row.amount));
    setEditNotes(row.notes);
    setEditIsSponsored(row.isSponsorshipOrUnpaid);
    if (row.isSponsorshipOrUnpaid) {
      const isUnpaid = (row.notes || '').toLowerCase().includes('unpaid') || (row.sponsor_note || '').toLowerCase().includes('unpaid');
      setEditDebtType(isUnpaid ? 'unpaid_sponsorship' : 'unaccounted_sponsorship');
    } else {
      setEditDebtType('cancellation');
    }
    // Initialize editable instances list from row.instances with normalized dates
    const initialInstances: DebtorInstanceUpdateItem[] = row.instances.map((inst) => ({
      id: inst.id,
      date: normalizeDateToYMD(inst.date) || inst.date || '',
      service: inst.serviceCode || inst.service || 'PM',
      amount: inst.amount,
    }));
    setEditInstances(initialInstances);
    setEditError(null);
    setEditSuccessMessage(null);
  }

  function closeEditModal() {
    setEditTarget(null);
    setEditInstances([]);
    setEditError(null);
    setEditSuccessMessage(null);
  }

  function handleUpdateInstanceDate(index: number, newDate: string) {
    setEditInstances((prev) => {
      const next = [...prev];
      if (next[index]) {
        next[index] = { ...next[index], date: newDate };
      }
      return next;
    });
  }

  function handleUpdateInstanceService(index: number, newService: string) {
    setEditInstances((prev) => {
      const next = [...prev];
      if (next[index]) {
        next[index] = { ...next[index], service: newService };
      }
      return next;
    });
  }

  function handleUpdateInstanceAmount(index: number, newAmountStr: string) {
    const rawVal = newAmountStr.trim();
    const parsed = rawVal === '' ? 0 : Number(rawVal);
    const amountVal = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    setEditInstances((prev) => {
      const next = [...prev];
      if (next[index]) {
        next[index] = { ...next[index], amount: amountVal };
      }
      const total = next.reduce((sum, item) => sum + item.amount, 0);
      setEditDebt(String(total));
      return next;
    });
  }

  function handleTotalDebtChange(newTotalStr: string) {
    setEditDebt(newTotalStr);
    const target = Number(newTotalStr);
    if (!Number.isFinite(target) || target < 0) return;

    setEditInstances((prev) => {
      if (prev.length === 0) return prev;
      if (prev.length === 1) {
        return [{ ...prev[0], amount: target }];
      }
      // Distribute sequentially among instances
      let remaining = target;
      return prev.map((inst, i) => {
        const isLast = i === prev.length - 1;
        if (isLast) {
          return { ...inst, amount: remaining };
        }
        const assigned = Math.min(remaining, inst.amount || 40);
        remaining -= assigned;
        return { ...inst, amount: assigned };
      });
    });
  }

  function handleRemoveSpecificInstance(index: number) {
    setEditInstances((prev) => {
      const next = prev.filter((_, i) => i !== index);
      const total = next.reduce((sum, item) => sum + item.amount, 0);
      setEditDebt(String(total));
      return next;
    });
  }

  function handleAddNewInstance() {
    const today = new Date().toISOString().slice(0, 10);
    setEditInstances((prev) => {
      const next = [...prev, { date: today, service: 'PM', amount: 40 }];
      const total = next.reduce((sum, item) => sum + item.amount, 0);
      setEditDebt(String(total));
      return next;
    });
  }

  async function handleSaveDebtorEdit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!editTarget) return;
    if (!editName.trim()) {
      setEditError('Passenger name cannot be empty.');
      return;
    }
    const targetStructure = normalizeStructureCode(editStructure);
    if (!targetStructure) {
      setEditError('Structure cannot be empty.');
      return;
    }

    const rawDebt = Number(editDebt);
    if (!Number.isFinite(rawDebt) || rawDebt < 0) {
      setEditError('Please enter a valid non-negative debt amount (e.g. 0, 20, 40).');
      return;
    }

    setSavingEdit(true);
    setEditError(null);
    try {
      const isSpon = editDebtType !== 'cancellation';
      const defaultNote = editDebtType === 'unpaid_sponsorship' ? 'Unpaid Sponsorship' : 'Unaccounted Sponsorship';
      const finalNotes = isSpon ? (editNotes.trim() || defaultNote) : '';

      if (editInstances.length === 0 || rawDebt === 0) {
        // If user deleted all date instances or set debt to 0, completely settle/remove debtor
        await updateDebtorWithInstances(editTarget.entryIds, {
          name: editName.trim(),
          structure: targetStructure,
          isSponsored: isSpon,
          notes: finalNotes,
          instances: [],
        });
      } else {
        await updateDebtorWithInstances(editTarget.entryIds, {
          name: editName.trim(),
          structure: targetStructure,
          isSponsored: isSpon,
          notes: finalNotes,
          instances: editInstances,
        });
      }

      const refreshed = await listLedgerEntries();
      setEntries(refreshed);
      setEditSuccessMessage('Debtor dates, structure, and amount updated successfully.');
      setTimeout(() => {
        closeEditModal();
      }, 500);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDeleteEntireDebtor() {
    if (!editTarget) return;
    const confirmDelete = window.confirm(
      `Are you sure you want to completely remove ${editTarget.name} (R${editTarget.amount}) from the ledger?`
    );
    if (!confirmDelete) return;

    setDeletingDebtor(true);
    setEditError(null);
    try {
      await Promise.all(editTarget.entryIds.map((id) => deleteLedgerEntry(id)));
      const idSet = new Set(editTarget.entryIds);
      setEntries((prev) => prev.filter((e) => !idSet.has(e.id)));
      closeEditModal();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingDebtor(false);
    }
  }

  function openAddModal() {
    setAddFirstName('');
    setAddSurname('');
    setAddStructure(structureFilter || 'S1');
    setAddService('PM');
    setAddAmount('40');
    setAddDate(new Date().toISOString().slice(0, 10));
    setAddNotes('');
    setAddIsSponsored(false);
    setAddDebtType('cancellation');
    setAddError(null);
    setAddSuccessMessage(null);
    setShowAddModal(true);
  }

  function closeAddModal() {
    setShowAddModal(false);
    setAddError(null);
  }

  async function handleAddDebtor() {
    if (!addFirstName.trim()) {
      setAddError('First name is required.');
      return;
    }
    if (!addSurname.trim()) {
      setAddError('Surname is required.');
      return;
    }
    const targetStructure = normalizeStructureCode(addStructure);
    if (!targetStructure) {
      setAddError('Structure is required.');
      return;
    }
    if (!addDate) {
      setAddError('Date is required.');
      return;
    }
    const amtNum = Number(addAmount);
    if (!Number.isFinite(amtNum) || amtNum <= 0) {
      setAddError('Please enter a valid positive amount.');
      return;
    }

    setAddingDebtor(true);
    setAddError(null);
    try {
      const isSpon = addDebtType !== 'cancellation';
      const defaultNote = addDebtType === 'unpaid_sponsorship' ? 'Unpaid Sponsorship' : 'Unaccounted Sponsorship';
      const finalNotes = isSpon ? (addNotes.trim() || defaultNote) : '';

      await addManualLedgerEntry({
        firstName: addFirstName,
        surname: addSurname,
        structure: targetStructure,
        service: addService,
        amount: amtNum,
        date: addDate,
        notes: finalNotes,
        isSponsored: isSpon,
      });

      const refreshed = await listLedgerEntries();
      setEntries(refreshed);
      setAddSuccessMessage(`Added ${addFirstName.trim()} ${addSurname.trim()} (R${amtNum}) to ${targetStructure}`);
      setTimeout(() => {
        closeAddModal();
      }, 900);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingDebtor(false);
    }
  }

  async function handleVerifySponsorship(id: string, newStatus: SponsorshipStatus) {
    const target = sponsorships.find((s) => s.id === id);
    const rawName = target ? target.passenger_name : 'Passenger';
    const name = sanitizePassengerDisplayName(rawName);
    const struct = target ? normalizeStructureCode(target.structure) : 'Structure';

    // Optimistic UI state update: immediately reflect change so it disappears from Pending view!
    setSponsorships((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: newStatus, status_updated_at: new Date().toISOString() } : s))
    );
    setSponsorshipUpdatingId(id);

    if (newStatus === 'actually_sponsored') {
      setSponsorshipNotice({
        id,
        text: `✓ Confirmed: ${name} was actually sponsored. Cleared from pending queue.`,
        type: 'success',
      });
    } else if (newStatus === 'unpaid_sponsorship') {
      setSponsorshipNotice({
        id,
        text: `Recorded ${name} as Unpaid Sponsorship (R40 debt) on ${struct} ledger.`,
        type: 'warn',
      });
    } else if (newStatus === 'unaccounted_sponsorship') {
      setSponsorshipNotice({
        id,
        text: `Recorded ${name} as Unaccounted Sponsorship (R40 debt) on ${struct} ledger.`,
        type: 'warn',
      });
    } else {
      setSponsorshipNotice({
        id,
        text: `Reset ${name} sponsorship status to Pending Verification.`,
        type: 'warn',
      });
    }
    setTimeout(() => setSponsorshipNotice(null), 5000);

    try {
      const res = await verifySponsorshipStatus(id, newStatus);
      if (res.success) {
        const [updatedSpon, updatedLedger] = await Promise.all([
          listReportedSponsorships(),
          listLedgerEntries(),
        ]);
        setSponsorships(updatedSpon);
        setEntries(updatedLedger);
      }
    } catch (err) {
      console.error('Failed to verify sponsorship:', err);
    } finally {
      setSponsorshipUpdatingId(null);
    }
  }

  async function handleConfirmPayment() {
    if (!paymentTarget) return;
    const amountNum = Number(paymentAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setPaymentError('Please enter a valid positive payment amount (e.g. 20, 40, 80).');
      return;
    }
    if (amountNum > paymentTarget.amount) {
      setPaymentError(`Amount cannot exceed the total outstanding debt of R${paymentTarget.amount}.`);
      return;
    }

    setPaying(true);
    setPaymentError(null);
    try {
      await recordPartialPayment(paymentTarget.entryIds, amountNum);
      const refreshed = await listLedgerEntries();
      setEntries(refreshed);
      closePaymentModal();
    } catch (e) {
      setPaymentError(e instanceof Error ? e.message : String(e));
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="min-h-screen">
      <Header current="ledger" />
      <main className="mx-auto max-w-5xl px-3 py-4 sm:px-6 sm:py-6">
        {/* Clean Header */}
        <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 sm:gap-3 border-b border-line pb-4 sm:pb-5">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-xl font-bold tracking-tight text-ink sm:text-2xl">
                Cancellation Ledger
              </h1>
              <span className="badge bg-card-2 text-ink-muted border border-line text-[11px]">
                Debtors & Sponsees
              </span>
            </div>
            <p className="mt-1 text-xs sm:text-sm text-muted">
              Official record of transport cancellation debt, structure groupings, and payment tracking.
            </p>
          </div>
        </div>

        {/* Top-Level Navigation Tabs */}
        <div className="mb-4 sm:mb-6 flex items-center border-b border-line gap-1 sm:gap-2">
          <button
            type="button"
            onClick={() => {
              setActiveTab('cancellations');
              if (typeof window !== 'undefined') {
                history.replaceState(null, '', window.location.pathname + window.location.search);
              }
            }}
            className={`flex items-center gap-2 pb-3 px-2 sm:px-3 text-xs sm:text-sm font-bold border-b-2 transition-all ${
              activeTab === 'cancellations'
                ? 'border-crimson-500 text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            <FileSpreadsheet className="h-4 w-4 shrink-0" />
            <span>Cancellations & Debtors</span>
            <span className="rounded-full bg-card-2 border border-line px-2 py-0.5 text-[11px] font-semibold text-muted">
              {entries.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTab('sponsorships');
              if (typeof window !== 'undefined') {
                history.replaceState(null, '', window.location.pathname + window.location.search + '#sponsorships');
              }
            }}
            className={`flex items-center gap-2 pb-3 px-2 sm:px-3 text-xs sm:text-sm font-bold border-b-2 transition-all ${
              activeTab === 'sponsorships'
                ? 'border-amber-500 text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            <HeartHandshake className="h-4 w-4 shrink-0 text-amber-400" />
            <span>Reported Sponsorships</span>
            {sponsorshipStats.pending > 0 ? (
              <span className="rounded-full bg-amber-500/20 border border-amber-500/40 px-2 py-0.5 text-[11px] font-bold text-amber-300 animate-pulse">
                {sponsorshipStats.pending} pending
              </span>
            ) : (
              <span className="rounded-full bg-card-2 border border-line px-2 py-0.5 text-[11px] font-semibold text-muted">
                {sponsorshipStats.total}
              </span>
            )}
          </button>
        </div>

        {loading ? (
          <div className="flex flex-col items-center gap-3 py-20">
            <Loader2 className="h-8 w-8 animate-spin text-crimson-400" />
            <p className="text-sm text-muted">Loading ledger…</p>
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-4 text-sm text-crimson-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : entries.length === 0 && sponsorships.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-card py-20 text-center">
            <XCircle className="h-10 w-10 text-line" />
            <p className="text-sm text-muted">No cancellations or reported sponsorships recorded yet.</p>
            <p className="text-xs text-muted">Absentees and sponsorships appear here once a transport rep submits attendance from the Rep Portal.</p>
          </div>
        ) : (
          <>
            {activeTab === 'cancellations' ? (
          <>
            {/* Review Queue Prompt if there are pending sponsorships */}
            {sponsorshipStats.pending > 0 && (
              <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200 shadow-sm">
                <div className="flex items-center gap-2.5 min-w-0">
                  <HeartHandshake className="h-4 w-4 text-amber-400 shrink-0" />
                  <span>
                    <strong>{sponsorshipStats.pending}</strong> reported sponsorship{sponsorshipStats.pending === 1 ? '' : 's'} waiting for administrative audit.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('sponsorships');
                    if (typeof window !== 'undefined') {
                      history.replaceState(null, '', window.location.pathname + window.location.search + '#sponsorships');
                    }
                  }}
                  className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-black hover:bg-amber-400 transition-colors self-start sm:self-auto"
                >
                  <span>Review Sponsorships Queue</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* Summary + download */}
            <div className="mb-4 sm:mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
                <SummaryStat label="Total Debts" value={entries.length} />
                <SummaryStat label="Filtered Debts" value={filtered.length} accent="crimson" />
                <SummaryStat label="Total Debt" value={`R${totalDebt}`} accent="warning" />
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('sponsorships');
                    if (typeof window !== 'undefined') {
                      history.replaceState(null, '', window.location.pathname + window.location.search + '#sponsorships');
                    }
                  }}
                  className="text-left w-full"
                  title="Switch to Reported Sponsorships review"
                >
                  <SummaryStat
                    label="Sponsorships"
                    value={sponsorships.length > 0 ? `${sponsorshipStats.total} (${sponsorshipStats.pending} pending)` : '0'}
                    accent={sponsorshipStats.pending > 0 ? 'warning' : 'success'}
                  />
                </button>
              </div>

              {/* Action buttons: prominent Add Debtor, compact touch-friendly exports on phone */}
              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={openAddModal}
                  className="btn-primary flex items-center justify-center gap-2 shadow-sm py-2.5 sm:py-2 text-xs sm:text-sm font-semibold"
                  title="Add a new debtor manually (Name, Surname, Structure, Service, Amount, Date)"
                >
                  <UserPlus className="h-4 w-4 shrink-0" />
                  <span>Add Debtor</span>
                </button>
                <div className="grid grid-cols-3 sm:flex sm:flex-wrap gap-1.5 sm:gap-2">
                  <input
                    ref={importInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={onImportInputChange}
                    className="hidden"
                  />
                  <button
                    onClick={() => importInputRef.current?.click()}
                    disabled={importing}
                    className="btn-ghost flex items-center justify-center gap-1.5 text-xs py-2 px-2"
                    title="Bulk-import historical cancellation records (Structure, Date, Service, Passenger Name, Amount)"
                  >
                    {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 shrink-0" />}
                    <span className="truncate">Import</span>
                  </button>
                  <button
                    onClick={() => downloadCancellationDebtPdf(filtered.length > 0 ? filtered : entries)}
                    className="btn-crimson flex items-center justify-center gap-1.5 text-xs py-2 px-2 shadow-sm"
                    title="Download official PDF report grouped by Structure and Person with CRC banking info"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Debt PDF</span>
                  </button>
                  <button
                    onClick={() => downloadLedgerExcel(filtered.length > 0 ? filtered : entries, `SZ_Cancellation_List_${new Date().toISOString().slice(0,10)}.xlsx`)}
                    className="btn-success flex items-center justify-center gap-1.5 text-xs py-2 px-2"
                    title="Export to Excel spreadsheet"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Excel</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Historical import feedback */}
            {importFileName && (importing || importResult || importError) && (
              <div className="mb-4 space-y-2 rounded-xl border border-line bg-card p-3 sm:p-4 animate-fade-in">
                {importing ? (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <Loader2 className="h-4 w-4 animate-spin text-crimson-400" />
                    Importing {importFileName}…
                  </div>
                ) : importError ? (
                  <div className="flex items-start gap-2 text-sm text-crimson-300">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    {importError}
                  </div>
                ) : importResult ? (
                  <>
                    <div className="flex items-center gap-2 text-sm font-semibold text-success-light">
                      <CheckCircle2 className="h-4 w-4" />
                      Imported {importResult.imported} of {importResult.totalRows} row(s) from {importFileName}
                    </div>
                    {importResult.skipped > 0 && (
                      <p className="text-xs text-muted">{importResult.skipped} row(s) skipped — see details below.</p>
                    )}
                    {importResult.warnings.length > 0 && (
                      <div className="max-h-32 space-y-1 overflow-y-auto text-xs text-warning">
                        {importResult.warnings.map((w, i) => (
                          <div key={i} className="flex items-start gap-1.5">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            <span>{w}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            )}

            {/* Search + filter controls */}
            <div className="mb-3 space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name, surname, or structure…"
                    className="input-field pl-10 pr-9 text-xs sm:text-sm py-2"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink hover:bg-card-2"
                      title="Clear search"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <div className="relative sm:w-56">
                  <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <select
                    value={structureFilter}
                    onChange={(e) => setStructureFilter(e.target.value)}
                    className="input-field pl-10 text-xs sm:text-sm py-2"
                  >
                    <option value="" className="bg-card-2">All Structures</option>
                    {structures.map((s) => (
                      <option key={s} value={s} className="bg-card-2">{s}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Quick horizontal structure pills for one-tap filtering on phone */}
              {structures.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 pt-0.5 no-scrollbar scroll-smooth">
                  <button
                    type="button"
                    onClick={() => setStructureFilter('')}
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold transition-all border ${
                      !structureFilter
                        ? 'bg-crimson-500 text-white border-crimson-500 shadow-xs'
                        : 'bg-card border-line/70 text-muted hover:text-ink hover:bg-card-2'
                    }`}
                  >
                    All ({structures.length})
                  </button>
                  {structures.map((s) => {
                    const isSelected = structureFilter === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setStructureFilter(isSelected ? '' : s)}
                        className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold transition-all border font-mono ${
                          isSelected
                            ? 'bg-crimson-500 text-white border-crimson-500 shadow-xs'
                            : 'bg-card border-line/70 text-muted hover:text-ink hover:bg-card-2'
                        }`}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {search.trim() && (
              <div className="mb-3 flex items-center justify-between rounded-lg border border-crimson-500/30 bg-crimson-500/10 px-3 py-1.5 text-xs text-crimson-300">
                <span className="truncate mr-2">
                  Filtering by: <strong>"{search.trim()}"</strong> · <strong>{filtered.length}</strong> debtor{filtered.length === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="text-xs font-semibold underline hover:text-crimson-200 shrink-0"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Expand / Collapse All Controls */}
            <div className="mb-3 flex items-center justify-between px-1 text-xs text-muted">
              <span>
                {groupedByStructure.length} structure{groupedByStructure.length === 1 ? '' : 's'} · {search.trim() ? `${groupedByStructure.length} matching` : `${openStructures.size} open`}
              </span>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <button
                  type="button"
                  onClick={expandAllStructures}
                  className="rounded-md border border-line/60 bg-card px-2.5 py-1 text-xs font-medium text-ink hover:bg-card-2 active:bg-card-2 transition-colors"
                >
                  Expand All
                </button>
                <button
                  type="button"
                  onClick={collapseAllStructures}
                  className="rounded-md border border-line/60 bg-card px-2.5 py-1 text-xs font-medium text-ink hover:bg-card-2 active:bg-card-2 transition-colors"
                >
                  Collapse All
                </button>
              </div>
            </div>

            {/* Grouped by structure — strict alphanumeric order (S1, S2, S9, S13) */}
            <div className="space-y-3 sm:space-y-4">
              {groupedByStructure.map(({ structure, rows, cancellationRows, sponsorshipRows, cancellationDebt, sponsorshipDebt, totalDebt: structDebt }) => {
                const isOpen = Boolean(search.trim()) || openStructures.has(structure);
                const isSpecialStructure = structure === 'No Structure' || structure === 'Unidentified' || structure.toLowerCase().startsWith('ftv');
                const structureLabel = isSpecialStructure ? structure : `Structure ${structure}`;

                return (
                  <div key={structure} className="overflow-hidden rounded-xl sm:rounded-2xl border border-line bg-card shadow-sm">
                    <button
                      onClick={() => toggleStructure(structure)}
                      className="flex w-full items-center justify-between gap-2 border-b border-line/60 bg-card-2/60 px-3.5 py-3 sm:px-4 sm:py-3.5 text-left transition-colors hover:bg-card-2 active:bg-card-2"
                    >
                      <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                        {isOpen ? <ChevronDown className="h-4 w-4 text-muted shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted shrink-0" />}
                        <span className="font-display text-sm font-bold text-ink">{structureLabel}</span>
                        <span className="badge bg-bg/60 text-muted text-[10px]">{rows.length} total</span>
                        {sponsorshipRows.length > 0 && (
                          <span className="badge bg-amber-500/15 text-amber-300 border border-amber-500/25 text-[10px]">
                            {sponsorshipRows.length} sponsorship
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 font-display text-sm font-bold shrink-0">
                        <span className="text-crimson-400">R{structDebt}</span>
                      </div>
                    </button>

                    {isOpen && (
                      <div className="space-y-3 sm:space-y-4 p-2.5 sm:p-4">
                        {/* Section 1: Regular Cancellations */}
                        {cancellationRows.length > 0 && (
                          <div className="overflow-hidden rounded-xl border border-line/70 bg-bg/50">
                            <div className="flex items-center justify-between border-b border-line/60 bg-card-2/40 px-3 py-2">
                              <span className="text-xs font-bold uppercase tracking-wider text-ink/80">
                                Cancellations ({cancellationRows.length})
                              </span>
                              <span className="font-display text-xs font-bold text-crimson-400">
                                Subtotal: R{cancellationDebt}
                              </span>
                            </div>

                            {/* Mobile Card Layout for Cancellations */}
                            <div className="block sm:hidden divide-y divide-line/40">
                              {cancellationRows.map((row) => (
                                <div key={`m-${row.key}`} className="p-3 space-y-2.5 transition-colors hover:bg-card-2/20">
                                  {/* Top row: Name & Amount */}
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                      <div className="font-bold text-ink text-sm leading-snug">
                                        <HighlightMatch text={row.name} query={search} />
                                      </div>
                                      <div className="flex items-center gap-1.5 mt-0.5">
                                        <span className="text-[11px] font-medium text-muted">
                                          {row.structure.startsWith('S') || row.structure.startsWith('YZ') ? `Structure ${row.structure}` : row.structure}
                                        </span>
                                        {row.instances.length > 1 && (
                                          <span className="text-[10px] text-muted rounded bg-card-2 px-1.5 py-0.5 border border-line/60">
                                            {row.instances.length} missed
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => openEditModal(row)}
                                      className="flex items-center gap-1 rounded-lg bg-crimson-500/10 px-2.5 py-1 text-right border border-crimson-500/25 active:bg-crimson-500/20 shrink-0"
                                      title={`Click to edit amount owing for ${row.name}`}
                                    >
                                      <span className="font-display text-base font-bold text-crimson-400">
                                        R{row.amount}
                                      </span>
                                      <Pencil className="h-3 w-3 text-crimson-400/70" />
                                    </button>
                                  </div>

                                  {/* Date & Service pills */}
                                  <div className="flex flex-wrap gap-1.5">
                                    {row.instances.map((ins, idx) => (
                                      <button
                                        key={idx}
                                        type="button"
                                        onClick={() => openEditModal(row)}
                                        className="inline-flex items-center gap-1.5 rounded-md bg-card-2 px-2 py-1 text-xs text-ink font-mono border border-line/60 active:border-crimson-400/60 transition-all text-left"
                                        title={`Click to edit date, service, or amount for ${ins.formatted}`}
                                      >
                                        <span>{ins.formatted}</span>
                                        <span className="text-[10px] text-crimson-400 font-sans font-semibold">R{ins.amount}</span>
                                        <Pencil className="h-2.5 w-2.5 text-muted" />
                                      </button>
                                    ))}
                                  </div>

                                  {/* Action Buttons: Thumb-friendly 40px touch targets */}
                                  <div className="flex items-center gap-2 pt-0.5">
                                    <button
                                      type="button"
                                      onClick={() => openPaymentModal(row)}
                                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/15 py-2 px-3 text-xs font-semibold text-emerald-300 active:bg-emerald-500/25 transition-colors"
                                    >
                                      <Banknote className="h-4 w-4 shrink-0" />
                                      <span>Record Payment</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openEditModal(row)}
                                      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-card py-2 px-3 text-xs font-semibold text-ink active:bg-card-2 transition-colors shrink-0"
                                    >
                                      <Pencil className="h-3.5 w-3.5 text-muted shrink-0" />
                                      <span>Edit</span>
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>

                            {/* Desktop Table View for Cancellations */}
                            <div className="hidden sm:block overflow-x-auto">
                              <table className="w-full text-left text-sm">
                                <thead>
                                  <tr className="border-b border-line/60 bg-card-2/30 text-muted">
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Passenger Name</th>
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Date(s) & Service</th>
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Amount Owing</th>
                                    <th className="px-3.5 py-2.5 text-right font-display text-xs font-bold uppercase tracking-wider">Actions</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-line/40">
                                  {cancellationRows.map((row) => (
                                    <tr key={row.key} className="transition-colors hover:bg-card-2/20">
                                      <td className="px-3.5 py-2.5 align-top">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <span className="font-semibold text-ink">
                                            <HighlightMatch text={row.name} query={search} />
                                          </span>
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 text-muted align-top">
                                        <div className="flex flex-wrap gap-1.5 max-w-xs">
                                          {row.instances.map((ins, idx) => (
                                            <button
                                              key={idx}
                                              type="button"
                                              onClick={() => openEditModal(row)}
                                              className="group/pill inline-flex items-center gap-1 rounded bg-card-2/80 px-2 py-0.5 text-xs text-ink font-mono border border-line/60 hover:border-crimson-400/60 hover:bg-card transition-all cursor-pointer text-left"
                                              title={`Click to edit date, service, or amount for ${ins.formatted}`}
                                            >
                                              <span>{ins.formatted}</span>
                                              <span className="text-[10px] text-crimson-400 font-sans font-semibold">R{ins.amount}</span>
                                              <Pencil className="h-2.5 w-2.5 text-muted/50 opacity-0 group-hover/pill:opacity-100 transition-opacity ml-0.5" />
                                            </button>
                                          ))}
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 align-top">
                                        <div className="flex items-center gap-1.5">
                                          <button
                                            type="button"
                                            onClick={() => openEditModal(row)}
                                            className="group inline-flex items-center gap-1.5 rounded-lg px-2 py-1 transition-all hover:bg-card-2 border border-transparent hover:border-line/60 text-left"
                                            title={`Click to edit amount owing for ${row.name} (Current: R${row.amount})`}
                                          >
                                            <span className="font-display font-bold text-crimson-400 text-base group-hover:underline">
                                              R{row.amount}
                                            </span>
                                            <Pencil className="h-3 w-3 text-muted/60 opacity-0 group-hover:opacity-100 transition-opacity" />
                                          </button>
                                          {row.instances.length > 1 && (
                                            <span className="text-[10px] text-muted rounded bg-card-2 px-1.5 py-0.5 border border-line/60">
                                              {row.instances.length} missed
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 text-right align-top">
                                        <div className="flex items-center justify-end gap-1.5">
                                          <button
                                            onClick={() => openPaymentModal(row)}
                                            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                                            title="Record a payment or partial settlement from this debtor"
                                          >
                                            <Banknote className="h-3.5 w-3.5" />
                                            <span>Record Payment</span>
                                          </button>
                                          <button
                                            onClick={() => openEditModal(row)}
                                            className="inline-flex items-center gap-1 rounded-md border border-line bg-card px-2.5 py-1 text-xs font-medium text-ink hover:bg-card-2 transition-colors"
                                            title="Edit debtor details, add additional debt, or remove"
                                          >
                                            <Pencil className="h-3.5 w-3.5 text-muted" />
                                            <span>Edit</span>
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {/* Section 2: Unaccounted Sponsorships & Unpaid */}
                        {sponsorshipRows.length > 0 && (
                          <div className="overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/5">
                            <div className="flex items-center justify-between border-b border-amber-500/25 bg-amber-500/10 px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="h-2 w-2 rounded-full bg-amber-400"></span>
                                <span className="text-xs font-bold uppercase tracking-wider text-amber-300">
                                  Unaccounted Sponsorships & Unpaid Debt ({sponsorshipRows.length})
                                </span>
                              </div>
                              <span className="font-display text-xs font-bold text-amber-300">
                                Subtotal: R{sponsorshipDebt}
                              </span>
                            </div>

                            {/* Mobile Card Layout for Sponsorships */}
                            <div className="block sm:hidden divide-y divide-amber-500/15">
                              {sponsorshipRows.map((row) => (
                                <div key={`m-sp-${row.key}`} className="p-3 space-y-2.5 transition-colors hover:bg-amber-500/10">
                                  {/* Top row: Name & Amount */}
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                      <div className="font-bold text-ink text-sm leading-snug">
                                        <HighlightMatch text={row.name} query={search} />
                                      </div>
                                      <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-200 border border-amber-500/30">
                                          {row.notes || 'Unaccounted Sponsorship'}
                                        </span>
                                        {row.instances.length > 1 && (
                                          <span className="text-[10px] text-muted rounded bg-card-2 px-1.5 py-0.5 border border-line/60">
                                            {row.instances.length}x
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => openEditModal(row)}
                                      className="flex items-center gap-1 rounded-lg bg-amber-500/10 px-2.5 py-1 text-right border border-amber-500/30 active:bg-amber-500/20 shrink-0"
                                      title={`Click to edit amount owing for ${row.name}`}
                                    >
                                      <span className="font-display text-base font-bold text-amber-300">
                                        R{row.amount}
                                      </span>
                                      <Pencil className="h-3 w-3 text-amber-300/70" />
                                    </button>
                                  </div>

                                  {/* Date & Service pills */}
                                  <div className="flex flex-wrap gap-1.5">
                                    {row.instances.map((ins, idx) => (
                                      <button
                                        key={idx}
                                        type="button"
                                        onClick={() => openEditModal(row)}
                                        className="inline-flex items-center gap-1.5 rounded-md bg-card-2 px-2 py-1 text-xs text-ink font-mono border border-amber-500/30 active:border-amber-400 transition-all text-left"
                                        title={`Click to edit date, service, or amount for ${ins.formatted}`}
                                      >
                                        <span>{ins.formatted}</span>
                                        <span className="text-[10px] text-amber-300 font-sans font-semibold">R{ins.amount}</span>
                                        <Pencil className="h-2.5 w-2.5 text-amber-400" />
                                      </button>
                                    ))}
                                  </div>

                                  {/* Action Buttons: Thumb-friendly 40px touch targets */}
                                  <div className="flex items-center gap-2 pt-0.5">
                                    <button
                                      type="button"
                                      onClick={() => openPaymentModal(row)}
                                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/15 py-2 px-3 text-xs font-semibold text-emerald-300 active:bg-emerald-500/25 transition-colors"
                                    >
                                      <Banknote className="h-4 w-4 shrink-0" />
                                      <span>Record Payment</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openEditModal(row)}
                                      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-card py-2 px-3 text-xs font-semibold text-ink active:bg-card-2 transition-colors shrink-0"
                                    >
                                      <Pencil className="h-3.5 w-3.5 text-muted shrink-0" />
                                      <span>Edit</span>
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>

                            {/* Desktop Table View for Sponsorships */}
                            <div className="hidden sm:block overflow-x-auto">
                              <table className="w-full text-left text-sm">
                                <thead>
                                  <tr className="border-b border-amber-500/20 bg-amber-500/5 text-amber-200/70">
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Passenger Name</th>
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Date(s) & Service</th>
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Category / Note</th>
                                    <th className="px-3.5 py-2.5 font-display text-xs font-bold uppercase tracking-wider">Amount Owing</th>
                                    <th className="px-3.5 py-2.5 text-right font-display text-xs font-bold uppercase tracking-wider">Actions</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-amber-500/15">
                                  {sponsorshipRows.map((row) => (
                                    <tr key={row.key} className="transition-colors hover:bg-amber-500/10">
                                      <td className="px-3.5 py-2.5 align-top">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <span className="font-semibold text-ink">
                                            <HighlightMatch text={row.name} query={search} />
                                          </span>
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 text-muted align-top">
                                        <div className="flex flex-wrap gap-1.5 max-w-xs">
                                          {row.instances.map((ins, idx) => (
                                            <button
                                              key={idx}
                                              type="button"
                                              onClick={() => openEditModal(row)}
                                              className="group/pill inline-flex items-center gap-1 rounded bg-card-2/80 px-2 py-0.5 text-xs text-ink font-mono border border-amber-500/30 hover:border-amber-400 hover:bg-card transition-all cursor-pointer text-left"
                                              title={`Click to edit date, service, or amount for ${ins.formatted}`}
                                            >
                                              <span>{ins.formatted}</span>
                                              <span className="text-[10px] text-amber-300 font-sans font-semibold">R{ins.amount}</span>
                                              <Pencil className="h-2.5 w-2.5 text-amber-400/50 opacity-0 group-hover/pill:opacity-100 transition-opacity ml-0.5" />
                                            </button>
                                          ))}
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 align-top">
                                        <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-amber-500/15 text-amber-200 border border-amber-500/30">
                                          {row.notes || 'Unaccounted Sponsorship'}
                                        </span>
                                      </td>
                                      <td className="px-3.5 py-2.5 align-top">
                                        <div className="flex items-center gap-1.5">
                                          <button
                                            type="button"
                                            onClick={() => openEditModal(row)}
                                            className="group inline-flex items-center gap-1.5 rounded-lg px-2 py-1 transition-all hover:bg-card-2 border border-transparent hover:border-amber-500/30 text-left"
                                            title={`Click to edit amount owing for ${row.name} (Current: R${row.amount})`}
                                          >
                                            <span className="font-display font-bold text-amber-300 text-base group-hover:underline">
                                              R{row.amount}
                                            </span>
                                            <Pencil className="h-3 w-3 text-amber-300/60 opacity-0 group-hover:opacity-100 transition-opacity" />
                                          </button>
                                          {row.instances.length > 1 && (
                                            <span className="text-[10px] text-muted rounded bg-card-2 px-1.5 py-0.5 border border-line/60">
                                              {row.instances.length}x
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-3.5 py-2.5 text-right align-top">
                                        <div className="flex items-center justify-end gap-1.5">
                                          <button
                                            onClick={() => openPaymentModal(row)}
                                            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                                            title="Record a payment or partial settlement from this debtor"
                                          >
                                            <Banknote className="h-3.5 w-3.5" />
                                            <span>Record Payment</span>
                                          </button>
                                          <button
                                            onClick={() => openEditModal(row)}
                                            className="inline-flex items-center gap-1 rounded-md border border-line bg-card px-2.5 py-1 text-xs font-medium text-ink hover:bg-card-2 transition-colors"
                                            title="Edit debtor details, add additional debt, or remove"
                                          >
                                            <Pencil className="h-3.5 w-3.5 text-muted" />
                                            <span>Edit</span>
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          /* Reported Sponsorships Audit View (Grouped by Structure) */
          <div className="space-y-4 sm:space-y-6">
            {/* Sponsorship Summary Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
              <SummaryStat label="Total Reported" value={sponsorshipStats.total} />
              <SummaryStat
                label="Pending Audit"
                value={sponsorshipStats.pending}
                accent={sponsorshipStats.pending > 0 ? 'warning' : 'neutral'}
              />
              <SummaryStat label="Actually Sponsored" value={sponsorshipStats.confirmed} accent="success" />
              <SummaryStat label="Added to Debt Ledger" value={sponsorshipStats.debt} accent="crimson" />
            </div>

            {/* Status Announcement Notice */}
            {sponsorshipNotice && (
              <div
                className={`flex items-center gap-2 rounded-xl p-3 text-xs font-semibold animate-in fade-in duration-150 ${
                  sponsorshipNotice.type === 'success'
                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                    : 'bg-amber-500/15 border border-amber-500/30 text-amber-300'
                }`}
              >
                {sponsorshipNotice.type === 'success' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
                )}
                <span>{sponsorshipNotice.text}</span>
              </div>
            )}

            {/* Filter Tabs & Search Controls */}
            <div className="rounded-xl border border-line bg-card p-3 sm:p-4 space-y-3 shadow-xs">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                {/* Status Filter Tabs */}
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs no-scrollbar">
                  <button
                    type="button"
                    onClick={() => setSponsorshipFilter('pending')}
                    className={`shrink-0 rounded-lg px-3 py-1.5 font-bold transition-all border ${
                      sponsorshipFilter === 'pending'
                        ? 'bg-amber-500 text-black border-amber-500 shadow-xs'
                        : 'bg-card-2 border-line text-muted hover:text-ink'
                    }`}
                  >
                    Pending Review ({sponsorshipStats.pending})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSponsorshipFilter('all')}
                    className={`shrink-0 rounded-lg px-3 py-1.5 font-bold transition-all border ${
                      sponsorshipFilter === 'all'
                        ? 'bg-ink text-canvas border-ink shadow-xs'
                        : 'bg-card-2 border-line text-muted hover:text-ink'
                    }`}
                  >
                    All ({sponsorshipStats.total})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSponsorshipFilter('actually_sponsored')}
                    className={`shrink-0 rounded-lg px-3 py-1.5 font-bold transition-all border ${
                      sponsorshipFilter === 'actually_sponsored'
                        ? 'bg-emerald-500 text-black border-emerald-500 shadow-xs'
                        : 'bg-card-2 border-line text-muted hover:text-ink'
                    }`}
                  >
                    Actually Sponsored ({sponsorshipStats.confirmed})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSponsorshipFilter('debt')}
                    className={`shrink-0 rounded-lg px-3 py-1.5 font-bold transition-all border ${
                      sponsorshipFilter === 'debt'
                        ? 'bg-crimson-500 text-white border-crimson-500 shadow-xs'
                        : 'bg-card-2 border-line text-muted hover:text-ink'
                    }`}
                  >
                    Added to Ledger ({sponsorshipStats.debt})
                  </button>
                </div>

                {/* Search Bar */}
                <div className="relative w-full md:w-72">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted pointer-events-none" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search passenger, rep, stop…"
                    className="w-full rounded-lg border border-line bg-card-2 pl-9 pr-8 py-1.5 text-xs text-ink placeholder:text-muted focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  {search && (
                    <button
                      type="button"
                      onClick={() => setSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-ink"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Expand / Collapse Controls */}
              <div className="flex items-center justify-between pt-1 border-t border-line/60 text-xs text-muted">
                <span>
                  {groupedSponsorships.length} structure{groupedSponsorships.length === 1 ? '' : 's'} · {filteredSponsorships.length} passenger{filteredSponsorships.length === 1 ? '' : 's'}
                </span>
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <button
                    type="button"
                    onClick={expandAllSponsorshipStructures}
                    className="rounded-md border border-line/60 bg-card-2 px-2.5 py-1 text-xs font-medium text-ink hover:bg-card transition-colors"
                  >
                    Expand All
                  </button>
                  <button
                    type="button"
                    onClick={collapseAllSponsorshipStructures}
                    className="rounded-md border border-line/60 bg-card-2 px-2.5 py-1 text-xs font-medium text-ink hover:bg-card transition-colors"
                  >
                    Collapse All
                  </button>
                </div>
              </div>
            </div>

            {/* Grouped by Structure Sponsorship Cards */}
            {groupedSponsorships.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-card py-16 text-center">
                <HeartHandshake className="h-10 w-10 text-line" />
                <p className="text-sm text-muted font-medium">
                  {sponsorships.length === 0
                    ? 'No sponsored passengers reported in submitted attendance yet.'
                    : 'No reported sponsorships match the current search or filter.'}
                </p>
                {sponsorshipFilter !== 'all' && (
                  <button
                    type="button"
                    onClick={() => setSponsorshipFilter('all')}
                    className="rounded-lg border border-line px-3 py-1.5 text-xs font-bold text-ink hover:bg-card-2 transition-colors"
                  >
                    Show All Sponsorships
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-3 sm:space-y-4">
                {groupedSponsorships.map((group) => {
                  const isOpen = isSponsorshipStructureOpen(group.structure);
                  const isSpecial = group.structure === 'No Structure' || group.structure === 'Unidentified';
                  const structureLabel = isSpecial ? group.structure : `Structure ${group.structure}`;

                  return (
                    <div
                      key={group.structure}
                      className="overflow-hidden rounded-xl sm:rounded-2xl border border-line bg-card shadow-sm"
                    >
                      {/* Structure Accordion Header */}
                      <button
                        type="button"
                        onClick={() => toggleSponsorshipStructure(group.structure)}
                        className="w-full flex items-center justify-between p-3.5 sm:p-4 text-left hover:bg-card-2/60 active:bg-card-2 transition-colors select-none"
                      >
                        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                          <div className="flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400 font-mono font-bold text-xs sm:text-sm shrink-0">
                            {normalizeStructureCode(group.structure).slice(0, 3)}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-sm sm:text-base font-bold text-ink">
                                {structureLabel}
                              </h3>
                              <span className="rounded-full bg-card-2 border border-line px-2 py-0.5 text-[11px] font-semibold text-muted">
                                {group.items.length} {group.items.length === 1 ? 'passenger' : 'passengers'}
                              </span>
                              {group.pendingCount > 0 && (
                                <span className="rounded-full bg-amber-500/20 border border-amber-500/40 px-2 py-0.5 text-[11px] font-bold text-amber-300 animate-pulse">
                                  {group.pendingCount} pending audit
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <div className="hidden sm:flex items-center gap-2 text-xs text-muted">
                            {group.actuallySponsoredCount > 0 && (
                              <span className="text-emerald-400 font-medium">
                                {group.actuallySponsoredCount} confirmed
                              </span>
                            )}
                            {group.debtCount > 0 && (
                              <span className="text-crimson-400 font-medium">
                                {group.debtCount} on ledger
                              </span>
                            )}
                          </div>
                          <div className="rounded-lg p-1 text-muted hover:text-ink">
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </div>
                        </div>
                      </button>

                      {/* Accordion Body: Passenger Items */}
                      {isOpen && (
                        <div className="border-t border-line/70 divide-y divide-line/60 bg-card-2/20">
                          {group.items.map((s) => {
                            const isUpdating = sponsorshipUpdatingId === s.id;
                            const cleanName = sanitizePassengerDisplayName(s.passenger_name);

                            return (
                              <div
                                key={s.id}
                                className="p-3.5 sm:p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 transition-colors hover:bg-card-2/40"
                              >
                                {/* Passenger Information */}
                                <div className="space-y-1.5 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-bold text-sm sm:text-base text-ink">
                                      <HighlightMatch text={cleanName} query={search} />
                                    </span>
                                    {s.structure && (
                                      <span className="rounded bg-card-2 border border-line/70 px-1.5 py-0.5 text-[11px] font-mono font-bold text-ink">
                                        {normalizeStructureCode(s.structure)}
                                      </span>
                                    )}
                                    {s.service && (
                                      <span className="rounded bg-card-2 border border-line/60 px-1.5 py-0.5 text-[10px] font-bold text-muted uppercase">
                                        {s.service}
                                      </span>
                                    )}
                                    {s.stop && (
                                      <span className="text-xs text-muted">
                                        Stop: <strong className="text-ink font-medium">{s.stop}</strong>
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-2 text-xs text-muted flex-wrap">
                                    <span>Date: {s.date}</span>
                                    <span>•</span>
                                    <span>Vehicle: {s.vehicle_name}</span>
                                    <span>•</span>
                                    <span>Reported by: {s.rep_name || 'Transport Rep'}</span>
                                  </div>

                                  {s.sponsor_note && (
                                    <div className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200 mt-0.5">
                                      <span className="font-bold text-amber-300">Sponsor Note:</span>
                                      <span>{s.sponsor_note}</span>
                                    </div>
                                  )}
                                </div>

                                {/* Verification Drop Box Controls */}
                                <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 sm:gap-3 shrink-0 pt-2 lg:pt-0 border-t lg:border-t-0 border-line/40">
                                  <div className="flex flex-col gap-1">
                                    <label
                                      htmlFor={`group_spon_${s.id}`}
                                      className="text-[10px] font-bold uppercase tracking-wider text-muted"
                                    >
                                      Sponsorship Action (Drop Box)
                                    </label>
                                    <div className="flex items-center gap-2">
                                      <select
                                        id={`group_spon_${s.id}`}
                                        value={s.status}
                                        disabled={isUpdating}
                                        onChange={(e) =>
                                          handleVerifySponsorship(s.id, e.target.value as SponsorshipStatus)
                                        }
                                        className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold border transition-all cursor-pointer ${
                                          s.status === 'actually_sponsored'
                                            ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                                            : s.status === 'unpaid_sponsorship'
                                            ? 'bg-crimson-500/20 border-crimson-500/50 text-crimson-300'
                                            : s.status === 'unaccounted_sponsorship'
                                            ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                                            : 'bg-card border-amber-500/40 text-amber-200'
                                        }`}
                                      >
                                        <option value="pending" className="bg-card text-ink">
                                          ⏳ Pending Verification
                                        </option>
                                        <option value="actually_sponsored" className="bg-card text-emerald-400 font-semibold">
                                          ✓ Actually Sponsored (No Action)
                                        </option>
                                        <option value="unaccounted_sponsorship" className="bg-card text-amber-400 font-semibold">
                                          ⚠️ Unaccounted Sponsorship (Add R40 Debt)
                                        </option>
                                        <option value="unpaid_sponsorship" className="bg-card text-crimson-400 font-semibold">
                                          ❌ Unpaid Sponsorship (Add R40 Debt)
                                        </option>
                                      </select>
                                      {isUpdating && (
                                        <Loader2 className="h-4 w-4 animate-spin text-muted" />
                                      )}
                                    </div>
                                  </div>

                                  {/* Visual Status Indicator */}
                                  <div className="min-w-[170px]">
                                    {s.status === 'actually_sponsored' ? (
                                      <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                                        <span>Actually sponsored</span>
                                      </div>
                                    ) : s.status === 'unpaid_sponsorship' ? (
                                      <div className="flex items-center gap-1.5 text-xs font-semibold text-crimson-400">
                                        <AlertTriangle className="h-4 w-4 shrink-0" />
                                        <span>In Ledger: Unpaid (R40)</span>
                                      </div>
                                    ) : s.status === 'unaccounted_sponsorship' ? (
                                      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                                        <AlertTriangle className="h-4 w-4 shrink-0" />
                                        <span>In Ledger: Unaccounted (R40)</span>
                                      </div>
                                    ) : (
                                      <div className="flex items-center gap-1.5 text-xs text-amber-300 font-medium">
                                        <Clock className="h-4 w-4 shrink-0 text-amber-400" />
                                        <span>Awaiting check</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

            {/* Payment Modal */}
            {paymentTarget && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4 animate-fade-in backdrop-blur-sm">
                <div className="w-full max-w-md max-h-[92vh] overflow-y-auto rounded-2xl border border-line bg-card p-4 sm:p-6 shadow-2xl">
                  <div className="flex items-center justify-between border-b border-line pb-3">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-emerald-500/15 p-2 text-emerald-400 shrink-0">
                        <Banknote className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="font-display text-base sm:text-lg font-bold text-ink">Record Payment</h3>
                        <p className="text-xs text-muted">Deduct full or partial amount from debt</p>
                      </div>
                    </div>
                    <button
                      onClick={closePaymentModal}
                      disabled={paying}
                      className="rounded-lg p-1.5 text-muted hover:bg-card-2 hover:text-ink active:bg-card-2"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>

                  <div className="mt-3.5 space-y-3.5 sm:space-y-4">
                    <div className="rounded-xl border border-line/60 bg-card-2/60 p-3 sm:p-3.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted">Debtor:</span>
                        <span className="font-bold text-ink">{paymentTarget.name}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-sm">
                        <span className="text-muted">Structure:</span>
                        <span className="font-medium text-ink">{paymentTarget.structure}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-sm">
                        <span className="text-muted">Total Outstanding:</span>
                        <span className="font-display text-base font-bold text-crimson-400">R{paymentTarget.amount}</span>
                      </div>
                      <div className="mt-2 text-xs text-muted">
                        Missed sessions: <span className="font-mono text-ink/90">{paymentTarget.formattedDateList}</span>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1.5">
                        Amount Paid (R)
                      </label>
                      <div className="relative">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-bold text-muted">R</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          max={paymentTarget.amount}
                          step="10"
                          value={paymentAmount}
                          onChange={(e) => setPaymentAmount(e.target.value)}
                          placeholder="e.g. 40"
                          className="input-field pl-8 font-mono text-lg font-bold text-ink py-2"
                          autoFocus
                        />
                      </div>
                      {/* Quick preset chips */}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {paymentTarget.amount >= 20 && (
                          <button
                            type="button"
                            onClick={() => setPaymentAmount('20')}
                            className="rounded-md bg-card-2 px-2.5 py-1 text-xs text-muted hover:bg-card-2/80 hover:text-ink border border-line/60 active:bg-card"
                          >
                            R20
                          </button>
                        )}
                        {paymentTarget.amount >= 40 && (
                          <button
                            type="button"
                            onClick={() => setPaymentAmount('40')}
                            className="rounded-md bg-card-2 px-2.5 py-1 text-xs text-muted hover:bg-card-2/80 hover:text-ink border border-line/60 active:bg-card"
                          >
                            R40 (1 session)
                          </button>
                        )}
                        {paymentTarget.amount >= 80 && (
                          <button
                            type="button"
                            onClick={() => setPaymentAmount('80')}
                            className="rounded-md bg-card-2 px-2.5 py-1 text-xs text-muted hover:bg-card-2/80 hover:text-ink border border-line/60 active:bg-card"
                          >
                            R80 (2 sessions)
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setPaymentAmount(String(paymentTarget.amount))}
                          className="rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/25 border border-emerald-500/30 font-semibold active:bg-emerald-500/30"
                        >
                          Full Debt (R{paymentTarget.amount})
                        </button>
                      </div>
                    </div>

                    {paymentError && (
                      <div className="flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-2.5 text-xs text-crimson-300">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>{paymentError}</span>
                      </div>
                    )}

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2 pt-2 border-t border-line">
                      <button
                        type="button"
                        onClick={closePaymentModal}
                        disabled={paying}
                        className="btn-ghost text-xs py-2.5 sm:py-2 order-2 sm:order-1"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmPayment}
                        disabled={paying || !paymentAmount}
                        className="btn-success flex items-center justify-center gap-2 text-xs py-2.5 sm:py-2 order-1 sm:order-2 font-semibold shadow-md"
                      >
                        {paying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                        <span>Confirm Payment of R{paymentAmount || 0}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Manual Add Debtor Modal */}
            {showAddModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4 animate-fade-in backdrop-blur-sm">
                <div className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-2xl border border-line bg-card p-4 sm:p-6 shadow-2xl">
                  <div className="flex items-center justify-between border-b border-line pb-3">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-crimson-500/15 p-2 text-crimson-400 shrink-0">
                        <UserPlus className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="font-display text-base sm:text-lg font-bold text-ink">Add Debtor to Ledger</h3>
                        <p className="text-xs text-muted">Directly record an absentee cancellation or debt</p>
                      </div>
                    </div>
                    <button
                      onClick={closeAddModal}
                      disabled={addingDebtor}
                      className="rounded-lg p-1.5 text-muted hover:bg-card-2 hover:text-ink active:bg-card-2"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleAddDebtor();
                    }}
                    className="mt-3.5 space-y-3.5 sm:space-y-4"
                  >
                    {/* First Name & Surname */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          First Name <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          value={addFirstName}
                          onChange={(e) => setAddFirstName(e.target.value)}
                          placeholder="e.g. Amo"
                          className="input-field w-full text-sm py-2"
                          autoFocus
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Surname <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          value={addSurname}
                          onChange={(e) => setAddSurname(e.target.value)}
                          placeholder="e.g. Nhlabathi"
                          className="input-field w-full text-sm py-2"
                        />
                      </div>
                    </div>

                    {/* Structure & Service Type */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Structure <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          list="structure-options"
                          value={addStructure}
                          onChange={(e) => setAddStructure(e.target.value)}
                          onBlur={() => setAddStructure((s) => normalizeStructureCode(s))}
                          placeholder="e.g. S1, Unidentified, FTV 20"
                          className="input-field w-full font-mono text-sm font-semibold py-2"
                        />
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          <span className="text-[10px] uppercase font-bold text-muted mr-0.5">Quick:</span>
                          {['Unidentified', 'No Structure', 'FTV 20', 'S1', 'S2', 'S13'].map((qs) => (
                            <button
                              key={qs}
                              type="button"
                              onClick={() => setAddStructure(qs)}
                              className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition-all ${
                                normalizeStructureCode(addStructure) === qs
                                  ? 'bg-ink text-bg border-ink shadow-sm'
                                  : 'bg-card-2 text-muted hover:text-ink hover:border-line border-line/60'
                              }`}
                            >
                              {qs}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Service Type <span className="text-crimson-400">*</span>
                        </label>
                        <select
                          value={addService}
                          onChange={(e) => setAddService(e.target.value)}
                          className="input-field w-full text-sm py-2"
                        >
                          <option value="PM">PM (Evening Service)</option>
                          <option value="AM">AM (Morning Service)</option>
                          <option value="LM">LM (Leaders Meeting)</option>
                          <option value="WMP">WMP (Worship/Music/Prayer)</option>
                          <option value="EF">EF (Easter Friday)</option>
                          <option value="AD">AD (Ascension Day)</option>
                          <option value="FW">FW (Fast & Worship)</option>
                        </select>
                      </div>
                    </div>

                    {/* Amount & Date */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Amount Owing (R) <span className="text-crimson-400">*</span>
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 font-bold text-muted text-sm">R</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            min="1"
                            step="any"
                            required
                            value={addAmount}
                            onChange={(e) => setAddAmount(e.target.value)}
                            className="input-field w-full pl-7 font-mono font-bold text-sm py-2"
                          />
                        </div>
                        <div className="mt-1 flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => setAddAmount('40')}
                            className="text-[10px] text-muted hover:text-ink underline"
                          >
                            R40 (Standard)
                          </button>
                          <span className="text-[10px] text-muted">·</span>
                          <button
                            type="button"
                            onClick={() => setAddAmount('20')}
                            className="text-[10px] text-muted hover:text-ink underline"
                          >
                            R20
                          </button>
                          <span className="text-[10px] text-muted">·</span>
                          <button
                            type="button"
                            onClick={() => setAddAmount('80')}
                            className="text-[10px] text-muted hover:text-ink underline"
                          >
                            R80 (2 trips)
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Date <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="date"
                          required
                          value={addDate}
                          onChange={(e) => setAddDate(e.target.value)}
                          className="input-field w-full text-sm font-mono py-2"
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="addDebtTypeSelect" className="block text-xs font-bold uppercase tracking-wider text-muted">
                        Debt Classification / Drop Box <span className="text-crimson-400">*</span>
                      </label>
                      <select
                        id="addDebtTypeSelect"
                        value={addDebtType}
                        onChange={(e) => {
                          const val = e.target.value as 'cancellation' | 'unaccounted_sponsorship' | 'unpaid_sponsorship';
                          setAddDebtType(val);
                          setAddIsSponsored(val !== 'cancellation');
                          if (val === 'unaccounted_sponsorship' && (!addNotes || addNotes === 'Unpaid Sponsorship')) {
                            setAddNotes('Unaccounted Sponsorship');
                          } else if (val === 'unpaid_sponsorship' && (!addNotes || addNotes === 'Unaccounted Sponsorship')) {
                            setAddNotes('Unpaid Sponsorship');
                          } else if (val === 'cancellation' && (addNotes === 'Unaccounted Sponsorship' || addNotes === 'Unpaid Sponsorship')) {
                            setAddNotes('');
                          }
                        }}
                        className="input-field w-full text-xs sm:text-sm py-2 bg-card-2"
                      >
                        <option value="cancellation" className="bg-card text-ink">
                          Regular Cancellation (Absentee)
                        </option>
                        <option value="unaccounted_sponsorship" className="bg-card text-amber-300 font-semibold">
                          Unaccounted Sponsorship
                        </option>
                        <option value="unpaid_sponsorship" className="bg-card text-amber-300 font-semibold">
                          Unpaid Sponsorship
                        </option>
                      </select>
                    </div>

                    {/* Only show reason/notes if marked as Unaccounted Sponsorship / Unpaid */}
                    {addIsSponsored && (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-1.5 animate-in fade-in duration-150">
                        <label className="block text-xs font-bold uppercase tracking-wider text-amber-300">
                          Sponsorship / Unpaid Reason & Notes <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="text"
                          value={addNotes}
                          onChange={(e) => setAddNotes(e.target.value)}
                          placeholder="e.g. Unaccounted Sponsorship, Sponsor did not pay, Unpaid"
                          className="input-field w-full text-xs py-2"
                          required={addIsSponsored}
                          autoFocus
                        />
                        <p className="text-[10px] text-amber-200/70">
                          Reason or note for grouping this person under unaccounted sponsorship or unpaid debt.
                        </p>
                      </div>
                    )}

                    {addError && (
                      <div className="flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-2.5 text-xs text-crimson-300">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>{addError}</span>
                      </div>
                    )}

                    {addSuccessMessage && (
                      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-2.5 text-xs text-emerald-300">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                        <span>{addSuccessMessage}</span>
                      </div>
                    )}

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2 pt-3 border-t border-line">
                      <button
                        type="button"
                        onClick={closeAddModal}
                        disabled={addingDebtor}
                        className="btn-ghost text-xs py-2.5 sm:py-2 order-2 sm:order-1"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={addingDebtor}
                        className="btn-crimson flex items-center justify-center gap-2 text-xs font-semibold shadow-md py-2.5 sm:py-2 order-1 sm:order-2"
                      >
                        {addingDebtor ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                        <span>Add to Ledger</span>
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {/* Edit Debtor Modal */}
            {editTarget && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4 backdrop-blur-sm">
                <div className="card w-full max-w-lg max-h-[92vh] overflow-y-auto border border-line bg-card p-4 sm:p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
                  <div className="flex items-center justify-between border-b border-line pb-3">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-crimson-500/15 p-2 text-crimson-400 shrink-0">
                        <Pencil className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="font-display text-base sm:text-lg font-bold text-ink">Edit Debtor Details</h3>
                        <p className="text-xs text-muted">Adjust debt amount, add additional debt, or remove debtor</p>
                      </div>
                    </div>
                    <button
                      onClick={closeEditModal}
                      disabled={savingEdit || deletingDebtor}
                      className="rounded-lg p-1.5 text-muted hover:bg-card-2 hover:text-ink active:bg-card-2"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleSaveDebtorEdit();
                    }}
                    className="mt-3.5 space-y-3.5 sm:space-y-4"
                  >
                    {/* Passenger Name & Structure */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Passenger Name <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="input-field w-full text-sm font-semibold py-2"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-muted mb-1">
                          Structure <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          list="structure-options"
                          value={editStructure}
                          onChange={(e) => setEditStructure(e.target.value)}
                          onBlur={() => setEditStructure((s) => normalizeStructureCode(s))}
                          placeholder="e.g. S1, Unidentified, FTV 20"
                          className="input-field w-full font-mono text-sm font-semibold py-2"
                        />
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          <span className="text-[10px] uppercase font-bold text-muted mr-0.5">Quick:</span>
                          {['Unidentified', 'No Structure', 'FTV 20', 'S1', 'S2', 'S13'].map((qs) => (
                            <button
                              key={qs}
                              type="button"
                              onClick={() => setEditStructure(qs)}
                              className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition-all ${
                                normalizeStructureCode(editStructure) === qs
                                  ? 'bg-ink text-bg border-ink shadow-sm'
                                  : 'bg-card-2 text-muted hover:text-ink hover:border-line border-line/60'
                              }`}
                            >
                              {qs}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Amount Owing Section */}
                    <div className="rounded-xl border border-line bg-card-2/50 p-3 sm:p-3.5 space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-bold uppercase tracking-wider text-ink">
                          Amount Owing (R) <span className="text-crimson-400">*</span>
                        </label>
                        {Number(editDebt) !== editTarget.amount && Number.isFinite(Number(editDebt)) && (
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                            Number(editDebt) > editTarget.amount
                              ? 'bg-crimson-500/15 text-crimson-400 border border-crimson-500/30'
                              : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          }`}>
                            {Number(editDebt) > editTarget.amount
                              ? `+R${Math.round((Number(editDebt) - editTarget.amount) * 100) / 100}`
                              : `-R${Math.round((editTarget.amount - Number(editDebt)) * 100) / 100}`}
                          </span>
                        )}
                      </div>

                      {/* Main Amount Input */}
                      <div className="relative">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-display text-lg font-bold text-muted">
                          R
                        </span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          step="any"
                          required
                          value={editDebt}
                          onChange={(e) => handleTotalDebtChange(e.target.value)}
                          className="input-field w-full pl-9 pr-4 py-2 font-display text-xl font-bold text-crimson-400 focus:text-crimson-300"
                          placeholder="e.g. 40"
                          autoFocus
                        />
                      </div>

                      {/* Quick Presets & Modifiers */}
                      <div className="space-y-2 pt-2 border-t border-line/60">
                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
                          <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center gap-1.5">
                            {[0, 20, 40, 60, 80, 120].map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => handleTotalDebtChange(String(preset))}
                                className={`rounded-md px-2 py-1.5 sm:px-2.5 sm:py-1 text-xs font-semibold font-mono text-center transition-colors border ${
                                  Number(editDebt) === preset
                                    ? 'bg-crimson-500 text-white border-crimson-500 shadow-sm'
                                    : 'bg-card border-line text-ink hover:bg-card-2 hover:border-line/80 active:bg-card-2'
                                }`}
                              >
                                {preset === 0 ? 'R0 (Clear)' : `R${preset}`}
                              </button>
                            ))}
                          </div>

                          <div className="grid grid-cols-3 sm:flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleTotalDebtChange(String(Math.max(0, (Number(editDebt) || 0) - 20)))}
                              className="rounded-md border border-line bg-card py-1.5 px-2 text-xs font-semibold text-muted hover:text-ink hover:bg-card-2 active:bg-card-2 transition-colors text-center"
                              title="Subtract R20"
                            >
                              -R20
                            </button>
                            <button
                              type="button"
                              onClick={() => handleTotalDebtChange(String((Number(editDebt) || 0) + 20))}
                              className="rounded-md border border-line bg-card py-1.5 px-2 text-xs font-semibold text-emerald-400 hover:bg-card-2 active:bg-card-2 transition-colors text-center"
                              title="Add R20"
                            >
                              +R20
                            </button>
                            <button
                              type="button"
                              onClick={() => handleTotalDebtChange(String((Number(editDebt) || 0) + 40))}
                              className="rounded-md border border-line bg-card py-1.5 px-2 text-xs font-semibold text-emerald-400 hover:bg-card-2 active:bg-card-2 transition-colors text-center"
                              title="Add R40"
                            >
                              +R40
                            </button>
                          </div>
                        </div>
                      </div>

                      {Number(editDebt) === 0 && (
                        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/25 p-2 text-xs text-emerald-300">
                          Saving R0 will mark this debtor as fully settled and clear the record from the active ledger.
                        </div>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="editDebtTypeSelect" className="block text-xs font-bold uppercase tracking-wider text-muted">
                        Debt Classification / Drop Box <span className="text-crimson-400">*</span>
                      </label>
                      <select
                        id="editDebtTypeSelect"
                        value={editDebtType}
                        onChange={(e) => {
                          const val = e.target.value as 'cancellation' | 'unaccounted_sponsorship' | 'unpaid_sponsorship';
                          setEditDebtType(val);
                          setEditIsSponsored(val !== 'cancellation');
                          if (val === 'unaccounted_sponsorship' && (!editNotes || editNotes === 'Unpaid Sponsorship')) {
                            setEditNotes('Unaccounted Sponsorship');
                          } else if (val === 'unpaid_sponsorship' && (!editNotes || editNotes === 'Unaccounted Sponsorship')) {
                            setEditNotes('Unpaid Sponsorship');
                          } else if (val === 'cancellation' && (editNotes === 'Unaccounted Sponsorship' || editNotes === 'Unpaid Sponsorship')) {
                            setEditNotes('');
                          }
                        }}
                        className="input-field w-full text-xs sm:text-sm py-2 bg-card-2"
                      >
                        <option value="cancellation" className="bg-card text-ink">
                          Regular Cancellation (Absentee)
                        </option>
                        <option value="unaccounted_sponsorship" className="bg-card text-amber-300 font-semibold">
                          Unaccounted Sponsorship
                        </option>
                        <option value="unpaid_sponsorship" className="bg-card text-amber-300 font-semibold">
                          Unpaid Sponsorship
                        </option>
                      </select>
                    </div>

                    {/* Only show reason/notes if marked as Unaccounted Sponsorship / Unpaid */}
                    {editIsSponsored && (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-1.5 animate-in fade-in duration-150">
                        <label className="block text-xs font-bold uppercase tracking-wider text-amber-300">
                          Sponsorship / Unpaid Reason & Remarks <span className="text-crimson-400">*</span>
                        </label>
                        <input
                          type="text"
                          value={editNotes}
                          onChange={(e) => setEditNotes(e.target.value)}
                          placeholder="e.g. Unaccounted Sponsorship, Did not pay, Unpaid"
                          className="input-field w-full text-xs py-2"
                          required={editIsSponsored}
                          autoFocus
                        />
                        <p className="text-[10px] text-amber-200/70">
                          Reason or remarks for this unaccounted sponsorship or unpaid entry.
                        </p>
                      </div>
                    )}

                    {/* Linked Cancellation Dates & Instances Manager */}
                    <div className="rounded-xl border border-line bg-card-2/40 p-3 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-xs font-bold uppercase tracking-wider text-ink block">
                            Cancellation Dates & Trips ({editInstances.length})
                          </span>
                          <p className="text-[11px] text-muted">
                            Modify any date, adjust service types, or remove a specific date in-between.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={handleAddNewInstance}
                          className="inline-flex items-center gap-1 rounded-md border border-line bg-card px-2.5 py-1 text-xs font-semibold text-ink hover:bg-card-2 active:bg-card-2 transition-colors shrink-0"
                          title="Add an extra missed date for this passenger"
                        >
                          <Plus className="h-3.5 w-3.5 text-crimson-400" />
                          <span>Add Date</span>
                        </button>
                      </div>

                      {editInstances.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-line/80 p-3 text-center text-xs text-muted">
                          All dates removed. Saving will clear this debtor from the ledger.
                        </div>
                      ) : (
                        <>
                          {/* Mobile view for each instance */}
                          <div className="block sm:hidden space-y-2 max-h-60 overflow-y-auto pr-0.5">
                            {editInstances.map((inst, idx) => (
                              <div
                                key={inst.id || `m-inst-${idx}`}
                                className="rounded-lg bg-card p-2.5 border border-line/70 space-y-2 shadow-xs"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-[11px] font-mono font-bold text-muted w-5 shrink-0">
                                    #{idx + 1}
                                  </span>
                                  <input
                                    type="date"
                                    value={inst.date}
                                    onChange={(e) => handleUpdateInstanceDate(idx, e.target.value)}
                                    className="input-field flex-1 text-xs py-1.5 px-2 font-mono"
                                  />
                                  <select
                                    value={inst.service}
                                    onChange={(e) => handleUpdateInstanceService(idx, e.target.value)}
                                    className="input-field w-20 text-xs py-1.5 px-1 font-bold text-center"
                                  >
                                    <option value="PM">PM</option>
                                    <option value="AM">AM</option>
                                    <option value="LM">LM</option>
                                    <option value="WMP">WMP</option>
                                    <option value="EF">EF</option>
                                    <option value="AD">AD</option>
                                    <option value="FW">FW</option>
                                  </select>
                                </div>
                                <div className="flex items-center justify-between gap-2 pt-1 border-t border-line/40">
                                  <div className="relative flex-1">
                                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-muted">R</span>
                                    <input
                                      type="number"
                                      inputMode="numeric"
                                      min="0"
                                      step="5"
                                      value={inst.amount}
                                      onChange={(e) => handleUpdateInstanceAmount(idx, e.target.value)}
                                      className="input-field w-full text-xs py-1.5 pl-6 pr-2 font-mono font-bold text-crimson-400"
                                    />
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveSpecificInstance(idx)}
                                    className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-crimson-400 bg-crimson-500/10 border border-crimson-500/20 active:bg-crimson-500/20"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    <span>Remove</span>
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>

                          {/* Desktop view for each instance */}
                          <div className="hidden sm:block space-y-2 max-h-56 overflow-y-auto pr-1">
                            {editInstances.map((inst, idx) => (
                              <div
                                key={inst.id || `new-inst-${idx}`}
                                className="flex items-center gap-2 rounded-lg bg-card p-2 border border-line/60 shadow-xs"
                              >
                                <span className="text-[11px] font-mono font-semibold text-muted/80 w-5 shrink-0 text-center">
                                  #{idx + 1}
                                </span>

                                {/* Date picker */}
                                <div className="flex-1 min-w-[120px]">
                                  <input
                                    type="date"
                                    value={inst.date}
                                    onChange={(e) => handleUpdateInstanceDate(idx, e.target.value)}
                                    className="input-field w-full text-xs py-1 px-2 font-mono"
                                    title={`Edit date for instance #${idx + 1}`}
                                  />
                                </div>

                                {/* Service selection */}
                                <div className="w-20 shrink-0">
                                  <select
                                    value={inst.service}
                                    onChange={(e) => handleUpdateInstanceService(idx, e.target.value)}
                                    className="input-field w-full text-xs py-1 px-1.5 font-bold text-center"
                                    title="Service code"
                                  >
                                    <option value="PM">PM</option>
                                    <option value="AM">AM</option>
                                    <option value="LM">LM</option>
                                    <option value="WMP">WMP</option>
                                    <option value="EF">EF</option>
                                    <option value="AD">AD</option>
                                    <option value="FW">FW</option>
                                  </select>
                                </div>

                                {/* Debt amount for this specific date */}
                                <div className="w-18 shrink-0 relative">
                                  <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-muted">
                                    R
                                  </span>
                                  <input
                                    type="number"
                                    min="0"
                                    step="5"
                                    value={inst.amount}
                                    onChange={(e) => handleUpdateInstanceAmount(idx, e.target.value)}
                                    className="input-field w-full text-xs py-1 pl-4 pr-1 text-right font-mono font-bold text-crimson-400"
                                    title="Fee for this specific cancellation date"
                                  />
                                </div>

                                {/* Delete this specific date */}
                                <button
                                  type="button"
                                  onClick={() => handleRemoveSpecificInstance(idx)}
                                  className="rounded p-1 text-muted hover:text-crimson-400 hover:bg-crimson-500/10 transition-colors shrink-0"
                                  title={`Remove this specific date (${inst.date || 'Undated'}) from debtor`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>

                    {editError && (
                      <div className="flex items-center gap-2 rounded-lg border border-crimson-500/30 bg-crimson-900/20 p-2.5 text-xs text-crimson-300">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>{editError}</span>
                      </div>
                    )}

                    {editSuccessMessage && (
                      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-2.5 text-xs text-emerald-300">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                        <span>{editSuccessMessage}</span>
                      </div>
                    )}

                    <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2.5 pt-3 border-t border-line">
                      <button
                        type="button"
                        onClick={handleDeleteEntireDebtor}
                        disabled={savingEdit || deletingDebtor}
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 rounded-lg border border-crimson-500/30 bg-crimson-950/30 px-3 py-2 text-xs font-semibold text-crimson-300 hover:bg-crimson-900/40 active:bg-crimson-900/50 transition-colors"
                        title="Remove debtor from ledger completely"
                      >
                        {deletingDebtor ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 text-crimson-400" />}
                        <span>Remove Debtor</span>
                      </button>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={closeEditModal}
                          disabled={savingEdit || deletingDebtor}
                          className="btn-ghost flex-1 sm:flex-none text-xs py-2"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={savingEdit || deletingDebtor}
                          className="btn-crimson flex-1 sm:flex-none flex items-center justify-center gap-2 text-xs font-semibold shadow-md py-2"
                        >
                          {savingEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                          <span>Save Changes</span>
                        </button>
                      </div>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {/* Mobile Floating Action Button for Quick Add */}
            <button
              type="button"
              onClick={openAddModal}
              className="sm:hidden fixed bottom-6 right-4 z-30 flex items-center gap-2 rounded-full bg-crimson-500 px-4 py-3 text-white shadow-xl hover:bg-crimson-600 active:scale-95 transition-all border border-crimson-400/40"
              aria-label="Add new debtor"
            >
              <UserPlus className="h-5 w-5" />
              <span className="text-xs font-bold tracking-wide">Add Debtor</span>
            </button>

            {filtered.length === 0 && search && (
              <div className="mt-4 text-center text-sm text-muted">
                No entries match your search. Try different keywords or clear the filter.
              </div>
            )}

            {/* Datalist for Structure Auto-suggestions */}
            <datalist id="structure-options">
              <option value="Unidentified" />
              <option value="No Structure" />
              <option value="FTV 20" />
              {structures.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}

function SummaryStat({ label, value, accent }: { label: string; value: string | number; accent?: 'crimson' | 'warning' }) {
  const color = accent === 'crimson' ? 'text-crimson-400' : accent === 'warning' ? 'text-warning' : 'text-ink';
  return (
    <div className="card flex items-center gap-3 p-3">
      <div>
        <div className={`font-display text-xl font-bold ${color}`}>{value}</div>
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
      </div>
    </div>
  );
}
