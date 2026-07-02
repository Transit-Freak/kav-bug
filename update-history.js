#!/usr/bin/env node
/*
 * קו באג — מעדכן את history.json (מגמות לאורך זמן) אחרי כל סריקה שבועית.
 * שומר רשומה *אחת ליום* (תאריך UTC): totalLines, realCount, totalWasteDayKm
 * מ-country-scan.json, ו-gapsCount מ-rail-gaps.json. אם כבר יש רשומה מאותו
 * יום (הרצה חוזרת), מעדכן אותה במקום להוסיף כפולה.
 *
 * שימוש: node update-history.js [country-scan.json] [rail-gaps.json] [history.json]
 */
"use strict";
const fs = require("fs");

const countryPath = process.argv[2] || "country-scan.json";
const railPath = process.argv[3] || "rail-gaps.json";
const historyPath = process.argv[4] || "history.json";

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

const country = readJson(countryPath);
if (!country) { console.error("update-history: לא נמצא " + countryPath + " — מדלג."); process.exit(0); }
const rail = readJson(railPath);

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
const entry = {
  date: today,
  totalLines: country.totalLines || 0,
  realCount: country.realCount || 0,
  totalWasteDayKm: country.totalWasteDayKm || 0,
  railGapsCount: rail ? (rail.gapsCount || 0) : null,
};

let history = readJson(historyPath);
if (!Array.isArray(history)) history = [];
const idx = history.findIndex((h) => h.date === today);
if (idx >= 0) history[idx] = entry; else history.push(entry);
history.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

fs.writeFileSync(historyPath, JSON.stringify(history, null, 1));
console.error("update-history: נכתב " + historyPath + " (" + history.length + " רשומות, היום: " + JSON.stringify(entry) + ")");
