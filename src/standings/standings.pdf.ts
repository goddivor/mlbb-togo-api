import PDFDocument from 'pdfkit';
import { Lang } from './standings.constants';
import { StandingRow } from './standings.logic';

/**
 * Server-side PDF of a standings table (title, season, table). Kept simple:
 * one landscape A4 page per ~30 rows, no images.
 */

const LABELS: Record<Lang, Record<string, string>> = {
  fr: {
    title: 'Classement',
    season: 'Saison',
    scope: 'Périmètre',
    league: 'Saison régulière',
    playoff: 'Playoffs',
    all: 'Tous les matchs',
    frozen: 'Classement figé',
    generated: 'Généré le',
    rank: '#',
    team: 'Équipe',
    played: 'MJ',
    wins: 'V',
    losses: 'D',
    draws: 'N',
    winRate: 'WR%',
    diff: 'Diff',
    points: 'Pts',
    streak: 'Série',
    form: 'Forme',
    sos: 'SoS',
    qualify: 'Les {n} premières équipes sont qualifiées.',
    empty: 'Aucun match terminé sur ce périmètre.',
    pointsRule: 'Barème : victoire {win} pt(s), nul {draw}, défaite {loss}.',
  },
  en: {
    title: 'Standings',
    season: 'Season',
    scope: 'Scope',
    league: 'Regular season',
    playoff: 'Playoffs',
    all: 'All matches',
    frozen: 'Frozen standings',
    generated: 'Generated on',
    rank: '#',
    team: 'Team',
    played: 'GP',
    wins: 'W',
    losses: 'L',
    draws: 'D',
    winRate: 'WR%',
    diff: 'Diff',
    points: 'Pts',
    streak: 'Streak',
    form: 'Form',
    sos: 'SoS',
    qualify: 'The top {n} teams qualify.',
    empty: 'No completed match in this scope.',
    pointsRule: 'Scoring: win {win} pt(s), draw {draw}, loss {loss}.',
  },
};

export type PdfInput = {
  lang: Lang;
  seasonName: string;
  type: string;
  frozen: boolean;
  generatedAt: Date;
  qualifyTop: number;
  points: { win: number; draw: number; loss: number };
  rows: StandingRow[];
};

const COLS: { key: string; width: number; align: 'left' | 'right' | 'center' }[] = [
  { key: 'rank', width: 28, align: 'right' },
  { key: 'team', width: 190, align: 'left' },
  { key: 'played', width: 38, align: 'right' },
  { key: 'wins', width: 34, align: 'right' },
  { key: 'losses', width: 34, align: 'right' },
  { key: 'draws', width: 34, align: 'right' },
  { key: 'winRate', width: 48, align: 'right' },
  { key: 'diff', width: 44, align: 'right' },
  { key: 'points', width: 44, align: 'right' },
  { key: 'streak', width: 48, align: 'center' },
  { key: 'form', width: 70, align: 'center' },
  { key: 'sos', width: 44, align: 'right' },
];

const fmt = (tpl: string, params: Record<string, string | number>) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));

function cellValue(row: StandingRow, key: string): string {
  switch (key) {
    case 'rank':
      return String(row.rank);
    case 'team':
      return row.team.name;
    case 'played':
      return String(row.played);
    case 'wins':
      return String(row.wins);
    case 'losses':
      return String(row.losses);
    case 'draws':
      return String(row.draws);
    case 'winRate':
      return `${row.winRate}%`;
    case 'diff':
      return row.scoreDiff > 0 ? `+${row.scoreDiff}` : String(row.scoreDiff);
    case 'points':
      return String(row.points);
    case 'streak':
      return row.streak ? `${row.streak.type}${row.streak.count}` : '-';
    case 'form':
      return row.form.length ? row.form.join(' ') : '-';
    case 'sos':
      return row.sos == null ? '-' : `${row.sos}%`;
    default:
      return '';
  }
}

export function buildStandingsPdf(input: PdfInput): Promise<Buffer> {
  const L = LABELS[input.lang] ?? LABELS.fr;
  const dateLocale = input.lang === 'en' ? 'en-GB' : 'fr-FR';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;
    const tableWidth = COLS.reduce((s, c) => s + c.width, 0);
    const scale = usable / tableWidth;
    const widths = COLS.map((c) => c.width * scale);

    // Header
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(20).text(`${L.title} MLBB Togo`, left, 40);
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor('#374151')
      .text(`${L.season} : ${input.seasonName}`, { continued: false })
      .text(`${L.scope} : ${L[input.type] ?? input.type}${input.frozen ? ` (${L.frozen})` : ''}`)
      .fontSize(9)
      .fillColor('#6B7280')
      .text(`${L.generated} ${input.generatedAt.toLocaleString(dateLocale)}`)
      .text(fmt(L.pointsRule, input.points))
      .text(fmt(L.qualify, { n: input.qualifyTop }));
    doc.moveDown(0.8);

    if (input.rows.length === 0) {
      doc.fontSize(11).fillColor('#374151').text(L.empty);
      doc.end();
      return;
    }

    const rowH = 20;
    const drawHeader = () => {
      let x = left;
      const y = doc.y;
      doc.rect(left, y, usable, rowH).fill('#1F2937');
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
      COLS.forEach((c, i) => {
        doc.text(L[c.key] ?? c.key, x + 4, y + 6, { width: widths[i] - 8, align: c.align });
        x += widths[i];
      });
      doc.y = y + rowH;
    };

    drawHeader();
    doc.font('Helvetica').fontSize(9);
    for (const row of input.rows) {
      if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        drawHeader();
        doc.font('Helvetica').fontSize(9);
      }
      const y = doc.y;
      const qualified = row.rank <= input.qualifyTop;
      doc.rect(left, y, usable, rowH).fill(qualified ? '#ECFDF5' : row.rank % 2 ? '#FFFFFF' : '#F9FAFB');
      if (row.rank === input.qualifyTop) {
        doc.moveTo(left, y + rowH).lineTo(left + usable, y + rowH).lineWidth(1.2).stroke('#10B981');
      }
      let x = left;
      doc.fillColor('#111827');
      COLS.forEach((c, i) => {
        const bold = c.key === 'points' || c.key === 'team';
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
        doc.text(cellValue(row, c.key), x + 4, y + 6, { width: widths[i] - 8, align: c.align, lineBreak: false });
        x += widths[i];
      });
      doc.y = y + rowH;
    }
    doc.end();
  });
}
