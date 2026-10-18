#!/usr/bin/env node
/**
 * generate-cv-openrouter.mjs — Generate tailored CV JSON payloads via OpenRouter,
 * then build HTML and PDF using career-ops scripts.
 *
 * Based on modes/pdf.md pipeline Steps 14-22, but uses OpenRouter API instead
 * of the `claude` CLI (which requires Anthropic auth).
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = 'google/gemini-2.5-flash';
const DATA_ROOT = getCareerOpsRoot();

// Load CV and profile
const cvText = readFileSync(join(DATA_ROOT, 'cv.md'), 'utf-8');
const profileYml = readFileSync(join(DATA_ROOT, 'config', 'profile.yml'), 'utf-8');

// Extract candidate name
const nameMatch = profileYml.match(/full_name:\s*"([^"]+)"/);
const candidateName = nameMatch ? nameMatch[1] : 'Patrick Ruster';

// Read JDs and reports
const candidates = [
  { report: 237, company: 'AtScale', role: 'Enterprise Account Executive - East', jd: '/tmp/jd-atscale.json', slug: 'atscale' },
  { report: 238, company: 'ClickHouse', role: 'Enterprise Account Executive - Chicago', jd: '/tmp/jd-clickhouse-chi.json', slug: 'clickhouse' },
  { report: 239, company: 'Databricks', role: 'Strategic Enterprise Account Executive - CMEG', jd: '/tmp/jd-databricks-cmeg.json', slug: 'databricks-cmeg' },
  { report: 240, company: 'Databricks', role: 'Strategic Enterprise Account Executive - Financial Services', jd: '/tmp/jd-databricks-fs.txt', slug: 'databricks-fs' },
  { report: 241, company: 'Snowflake', role: 'Enterprise Account Executive, Observe', jd: '/tmp/jd-snowflake-observe.txt', slug: 'snowflake-observe' },
];

const systemPrompt = `# CV Tailoring Agent

Your task is to generate a JSON payload for \`build-cv-html.mjs\` that produces an ATS-optimized, tailored CV for the role described.

## Schema (ALL fields required unless noted):

\`\`\`json
{
  "lang": "en",
  "page_format": "letter",
  "candidate": {
    "name": "Patrick Ruster",
    "email": "ruster.patrick@gmail.com",
    "phone": "(585) 414-2907",
    "linkedin": "linkedin.com/in/pruster",
    "github": "github.com/prasta1"
  },
  "sections": { "summary": "Professional Summary", "experience": "Work Experience", "skills": "Skills", "projects": "Projects", "education": "Education", "certifications": "Certifications & Awards", "competencies": "Core Competencies" },
  "summary": "2-3 sentences for a recruiter. Answer: target role + strongest fit + proof.",
  "competencies": [
    {"category": "Sales & Revenue", "items": ["Net Revenue Retention", "Expansion", "..."]},
    {"category": "Enterprise Sales", "items": ["...", "..."]}
  ],
  "experience": [
    {
      "company": "Edge Impulse",
      "role": "Head of Global Customer Success",
      "location": "Remote",
      "context": "Acquired by Qualcomm",
      "dates": "June 2023 -- September 2026",
      "period": "2023–2026",
      "bullets": ["Achieved 101% NRR and 93% logo retention...", "..."]
    }
  ],
  "projects": [
    {"name": "Edge Impulse", "description": "Edge AI platform", "tech": "Swift, Python, ML", "url": "", "bullets": ["...", "..."]}
  ],
  "education": [{"title": "B.S. Business Administration", "org": "SUNY Plattsburgh", "location": "Plattsburgh, NY", "year": "2015", "description": ""}],
  "certifications": [{"title": "Edge Impulse Edge AI Certified", "org": "", "year": ""}],
  "awards": [{"title": "DataRobot President's Club", "org": "DataRobot", "year": "2018"}],
  "skills": [
    {"category": "Enterprise Sales", "items": ["New Logo Acquisition", "Land and Expand", "..."]},
    {"category": "AI/ML Platforms", "items": ["Edge Impulse", "DataRobot", "..."]}
  ]
}
\`\`\`

## Tailoring rules:
- **Reorder** work experience newest-first — never invent dates
- **Reweight** bullets to emphasize JD keywords: new logo acquisition, land & expand, territory strategy, MEDDPICC, technical buyer fluency
- **Summary** must answer: What role am I targeting, and why this one? + strongest proof point
- **Competencies** — 6-8 keyword phrases from the JD, drawn from real CV evidence only
- **Remove** any section that has no entries (don't leave empty arrays)
- **Never invent** metrics or achievements not in the CV
- **Keywords** to mirror: extract from the JD and inject naturally into existing achievements
- **Skills section** last, 2-4 categories with items as strings

Output ONLY valid JSON. No markdown, no prose.`;

async function callOpenRouter(systemPrompt, userMessage) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'HTTP-Referer': 'https://career-ops.local',
      'X-Title': 'career-ops-cv-gen',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

function readJD(path) {
  if (path.endsWith('.json')) {
    const d = JSON.parse(readFileSync(path, 'utf-8'));
    return d.text || '';
  }
  return readFileSync(path, 'utf-8');
}

async function processCandidate(c, idx) {
  console.log(`\n[${idx + 1}/5] ${c.company} — ${c.role}`);

  const jdText = readJD(c.jd);
  const reportPath = join(DATA_ROOT, 'reports', `${String(c.report).padStart(3, '0')}-${c.slug}-2026-10-12.md`);
  const reportContent = existsSync(reportPath) ? readFileSync(reportPath, 'utf-8') : '';

  // Extract keyword coverage from report
  const keywordMatch = reportContent.match(/## Keyword Coverage[\s\S]*?## \w/);
  const keywordSection = keywordMatch ? keywordMatch[0] : '';

  const userPrompt = `
Candidate: ${candidateName}
Company: ${c.company}
Role: ${c.role}

## CV (source of truth)
${cvText}

## Job Description
${jdText}

## Evaluation Report (keyword coverage + customization plan)
${keywordSection || reportContent.slice(0, 3000)}

Generate a tailored JSON CV payload for \`${c.company} — ${c.role}\`. Follow the schema exactly. Emphasize new logo acquisition, land-and-expand, territory strategy, MEDDPICC (where applicable), and technical buyer fluency. Output ONLY valid JSON.`;

  try {
    console.log('  🧠 Generating CV payload via OpenRouter...');
    const jsonStr = await callOpenRouter(systemPrompt, userPrompt);
    // Extract JSON from response (in case of extra text)
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    const payload = JSON.parse(jsonMatch[0]);

    // Save payload
    const payloadPath = `/tmp/cv-${candidateName.toLowerCase().replace(/\s/g, '-')}-${c.slug}.json`;
    writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
    console.log(`  ✅ Payload saved: ${payloadPath}`);

    // Generate HTML
    const htmlPath = `output/cv-${candidateName.toLowerCase().replace(/\s/g, '-')}-${c.slug}.html`;
    console.log(`  🏗️ Building HTML...`);
    execFileSync(process.execPath, ['build-cv-html.mjs', payloadPath, htmlPath, 'templates/cv-template.html'], {
      encoding: 'utf-8', stdio: 'inherit'
    });
    console.log(`  ✅ HTML saved: ${htmlPath}`);

    // Verify facts
    console.log(`  🔍 Verifying facts...`);
    try {
      execFileSync(process.execPath, ['verify-cv-facts.mjs', htmlPath], {
        encoding: 'utf-8', stdio: 'inherit'
      });
      console.log(`  ✅ Fact check passed`);
    } catch (e) {
      console.log(`  ⚠️ Fact check warning: ${e.message.slice(0, 100)}`);
    }

    // Generate PDF
    const pdfPath = `output/cv-${candidateName.toLowerCase().replace(/\s/g, '-')}-${c.slug}.pdf`;
    console.log(`  📄 Generating PDF...`);
    execFileSync(process.execPath, ['generate-pdf.mjs', htmlPath, pdfPath, `--format=letter`, `--report=${String(c.report).padStart(3, '0')}`], {
      encoding: 'utf-8', stdio: 'inherit'
    });
    console.log(`  ✅ PDF saved: ${pdfPath}`);

    return { candidate: c, success: true, htmlPath, pdfPath };
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    return { candidate: c, success: false, error: err.message };
  }
}

async function main() {
  if (!API_KEY) {
    console.error('❌ OPENROUTER_API_KEY not set');
    process.exit(1);
  }

  console.log(`Generating CVs for ${candidates.length} candidates...`);
  console.log(`Model: ${MODEL}`);
  console.log(`Candidate: ${candidateName}`);

  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const r = await processCandidate(candidates[i], i);
    results.push(r);
  }

  console.log('\n========================================');
  console.log('📊 CV Generation Summary:');
  for (const r of results) {
    if (r.success) {
      console.log(`  ✅ ${r.candidate.company} — PDF: ${r.pdfPath}`);
    } else {
      console.log(`  ❌ ${r.candidate.company} — ${r.error}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});