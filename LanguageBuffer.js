const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

class LanguageBuffer {
  constructor() {
    this.buffer = new Map();
    this.bufferFile = path.join(__dirname, '../profiles/language-buffer.json');
    this.expiry = 365 * 24 * 60 * 60 * 1000;
    this.saveScheduled = false;
    this.loadBuffer();
  }

  async loadBuffer() {
    try {
      const data = await fs.readFile(this.bufferFile, 'utf8');
      const parsed = JSON.parse(data);
      
      for (const [domain, entry] of Object.entries(parsed)) {
        if (this.isValidEntry(entry)) {
          this.buffer.set(domain, entry);
        }
      }
      
      config.smartLog('buffer', `Language buffer loaded: ${this.buffer.size} entries`);
    } catch (error) {
      config.smartLog('buffer', `Creating new language buffer file`);
      this.buffer.clear();
    }
  }

  isValidEntry(entry) {
    if (!entry || !entry.timestamp) return false;
    return (Date.now() - entry.timestamp) < this.expiry;
  }

  setLanguage(domain, language, source = 'detection') {
    const entry = {
      language,
      source,
      timestamp: Date.now(),
      detectedAt: new Date().toISOString()
    };
    
    this.buffer.set(domain, entry);
    this.scheduleFlush();
    
    config.smartLog('buffer', `Language buffered for ${domain}: ${language} (${source})`);
    return entry;
  }

  getLanguage(domain) {
    config.smartLog('buffer', `Looking for domain: "${domain}"`);
    config.smartLog('buffer', `Available domains: ${Array.from(this.buffer.keys())}`);
    
    const entry = this.buffer.get(domain);
    
    if (!entry) {
      config.smartLog('buffer', `Domain "${domain}" NOT FOUND in buffer`);
      return null;
    }
    
    if (!this.isValidEntry(entry)) {
      config.smartLog('buffer', `Domain "${domain}" EXPIRED, removing from buffer`);
      this.buffer.delete(domain);
      this.scheduleFlush();
      return null;
    }
    
    config.smartLog('buffer', `Language found for "${domain}": ${entry.language} (${entry.source})`);
    return entry.language;
  }

  hasLanguage(domain) {
    return this.getLanguage(domain) !== null;
  }

  scheduleFlush() {
    if (this.saveScheduled) return;
    
    this.saveScheduled = true;
    setTimeout(async () => {
      await this.flushToDisk();
      this.saveScheduled = false;
    }, 1000);
  }

  async flushToDisk() {
    try {
      const obj = Object.fromEntries(this.buffer);
      await fs.writeFile(this.bufferFile, JSON.stringify(obj, null, 2));
      config.smartLog('buffer', `Flushed ${Object.keys(obj).length} entries to disk`);
    } catch (error) {
      config.smartLog('fail', `Failed to flush language buffer: ${error.message}`);
    }
  }

  clearExpired() {
    let cleared = 0;
    for (const [domain, entry] of this.buffer.entries()) {
      if (!this.isValidEntry(entry)) {
        this.buffer.delete(domain);
        cleared++;
      }
    }
    
    if (cleared > 0) {
      config.smartLog('buffer', `Cleared ${cleared} expired language buffer entries`);
      this.scheduleFlush();
    }
    
    return cleared;
  }

  getStats() {
    const stats = {
      total: this.buffer.size,
      languages: {},
      sources: {},
      avgAge: 0
    };

    let totalAge = 0;
    for (const entry of this.buffer.values()) {
      const lang = entry.language || 'unknown';
      const source = entry.source || 'unknown';
      
      stats.languages[lang] = (stats.languages[lang] || 0) + 1;
      stats.sources[source] = (stats.sources[source] || 0) + 1;
      
      totalAge += (Date.now() - entry.timestamp);
    }

    stats.avgAge = stats.total > 0 ? Math.round(totalAge / stats.total / 1000 / 60) : 0;
    
    return stats;
  }

  clear() {
    const size = this.buffer.size;
    this.buffer.clear();
    this.scheduleFlush();
    config.smartLog('buffer', `Language buffer cleared: ${size} entries removed`);
    return size;
  }

  debugDomainLookup(url) {
    config.smartLog('buffer', `DEBUG DOMAIN LOOKUP`);
    config.smartLog('buffer', `URL: ${url}`);
    
    const DomainProfiler = require('./DomainProfiler');
    const profiler = new DomainProfiler();
    const domain = profiler.getDomainFromUrl(url);
    
    config.smartLog('buffer', `Domain from profiler: "${domain}"`);
    config.smartLog('buffer', `Available in buffer: ${this.buffer.has(domain)}`);
    config.smartLog('buffer', `Buffer domains: ${Array.from(this.buffer.keys())}`);
    
    return domain;
  }
}

const languageBuffer = new LanguageBuffer();

module.exports = languageBuffer;