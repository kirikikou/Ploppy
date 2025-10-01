const axios = require('axios');
const cheerio = require('cheerio');
const BaseScraperStep = require('./BaseScraperStep');
const { getRandomUserAgent } = require('../../utils');
const config = require('../../config');

class LightweightVariantsStep extends BaseScraperStep {
  constructor() {
    super('lightweight-variants', 2);
  }
  
  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting ${this.name} for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    const variants = this.generateVariants(url);
    const results = [];
    let scrapingError = null;
    
    for (const variant of variants) {
      try {
        const result = await this.fetchVariant(variant);
        if (result && this.isValidContent(result)) {
          results.push(result);
        }
      } catch (error) {
        config.smartLog('fail', `Variant ${variant.name} failed: ${error.message}`);
      }
    }
    
    if (results.length > 0) {
      const combinedResult = this.combineResults(results, url);
      config.smartLog('win', `Successfully found ${combinedResult.links.length} jobs via ${results.length} variants`);
      return combinedResult;
    }
    
    config.smartLog('fail', `No valid results found from any variant`);
    scrapingError = new Error('No valid results found from any variant');
    return null;
  }
  
  generateVariants(url) {
    const urlObj = new URL(url);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
    
    return [
      { name: 'original', url: url },
      { name: 'json', url: url.replace(/\/$/, '') + '.json' },
      { name: 'api', url: url.replace(/\/$/, '') + '/api' },
      { name: 'data', url: url.replace(/\/$/, '') + '/data' },
      { name: 'feed', url: url.replace(/\/$/, '') + '/feed' },
      { name: 'xml', url: url.replace(/\/$/, '') + '.xml' },
      { name: 'print', url: baseUrl + '?print=1' },
      { name: 'mobile', url: baseUrl + '?mobile=1' },
      { name: 'amp', url: baseUrl + '/amp' },
      { name: 'lite', url: baseUrl + '?lite=1' }
    ];
  }
  
  async fetchVariant(variant) {
    config.smartLog('steps', `Fetching ${variant.name} variant: ${variant.url}`);
    
    try {
      const response = await axios.get(variant.url, {
        timeout: 10000,
        maxRedirects: 3,
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate'
        },
        validateStatus: function (status) {
          return status >= 200 && status < 400;
        }
      });
      
      const contentType = response.headers['content-type'] || '';
      
      if (contentType.includes('json')) {
        return this.processJSON(response.data, variant);
      } else if (contentType.includes('xml')) {
        return this.processXML(response.data, variant);
      } else {
        return this.processHTML(response.data, variant);
      }
      
    } catch (error) {
      return null;
    }
  }
  
  processJSON(data, variant) {
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return null;
      }
    }
    
    const extractText = (obj, texts = []) => {
      if (!obj) return texts;
      
      if (typeof obj === 'string') {
        texts.push(obj);
      } else if (Array.isArray(obj)) {
        obj.forEach(item => extractText(item, texts));
      } else if (typeof obj === 'object') {
        Object.values(obj).forEach(value => extractText(value, texts));
      }
      
      return texts;
    };
    
    const texts = extractText(data);
    const combinedText = texts.join(' ');
    
    return {
      type: 'json',
      variant: variant.name,
      text: combinedText,
      data: data,
      links: this.extractLinksFromJSON(data),
      jobScore: this.calculateJobScore(combinedText)
    };
  }
  
  processXML(data, variant) {
    const $ = cheerio.load(data, { xmlMode: true });
    const text = $.text();
    
    return {
      type: 'xml',
      variant: variant.name,
      text: text,
      links: [],
      jobScore: this.calculateJobScore(text)
    };
  }
  
  processHTML(html, variant) {
    const $ = cheerio.load(html);
    
    $('script, style, noscript').remove();
    
    const text = $('body').text() || $.root().text();
    const cleanText = text.replace(/\s+/g, ' ').trim();
    const links = [];
    
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      const linkText = $(el).text().trim();
      if (href && linkText) {
        links.push({ 
          url: href, 
          text: linkText
        });
      }
    });
    
    return {
      type: 'html',
      variant: variant.name,
      text: cleanText,
      links: links,
      jobScore: this.calculateJobScore(cleanText),
      jobLinksCount: links.filter(l => this.isJobURL(l.url)).length
    };
  }
  
  extractLinksFromJSON(data, baseUrl = '') {
    const links = [];
    
    const extract = (obj) => {
      if (!obj) return;
      
      if (typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [key, value] of Object.entries(obj)) {
          if (typeof value === 'string' && (
            key.toLowerCase().includes('url') ||
            key.toLowerCase().includes('link') ||
            key.toLowerCase().includes('href') ||
            value.startsWith('http') ||
            value.startsWith('/')
          )) {
            links.push({ 
              url: value, 
              text: obj.title || obj.name || key
            });
          }
        }
        
        Object.values(obj).forEach(extract);
      } else if (Array.isArray(obj)) {
        obj.forEach(extract);
      }
    };
    
    extract(data);
    return links;
  }
  
  calculateJobScore(text) {
    if (!text || typeof text !== 'string') return 0;
    
    const normalizedText = text.toLowerCase();
    const jobTerms = this.getJobTerms();
    let score = 0;
    let matches = 0;
    
    jobTerms.forEach(term => {
      const termLower = term.toLowerCase();
      const regex = new RegExp(`\\b${termLower}\\b`, 'gi');
      const termMatches = (normalizedText.match(regex) || []).length;
      if (termMatches > 0) {
        score += termMatches;
        matches++;
      }
    });
    
    const textLength = text.length;
    const density = textLength > 0 ? (score / textLength) * 1000 : 0;
    
    return {
      total: score,
      matches: matches,
      density: density,
      terms: jobTerms.length
    };
  }
  
  isJobURL(url) {
    if (!url || typeof url !== 'string') return false;
    
    const jobURLPatterns = this.getJobURLPatterns();
    const jobDetailPatterns = this.getJobDetailURLPatterns();
    const allPatterns = [...jobURLPatterns, ...jobDetailPatterns];
    
    return allPatterns.some(pattern => {
      if (pattern instanceof RegExp) {
        return pattern.test(url);
      } else if (typeof pattern === 'string') {
        return url.toLowerCase().includes(pattern.toLowerCase());
      }
      return false;
    });
  }
  
  isValidContent(result) {
    if (!result || !result.text) return false;
    
    const minLength = 50;
    const minJobScore = 2;
    
    if (result.text.length < minLength) return false;
    
    if (result.jobScore && result.jobScore.total >= minJobScore) {
      return true;
    }
    
    if (result.jobLinksCount && result.jobLinksCount > 0) {
      return true;
    }
    
    if (result.links && result.links.some(link => this.isJobURL(link.url))) {
      return true;
    }
    
    const jobTerms = this.getJobTerms();
    const hasJobKeywords = jobTerms.some(term => 
      result.text.toLowerCase().includes(term.toLowerCase())
    );
    
    return hasJobKeywords;
  }
  
  combineResults(results, originalUrl) {
    const combinedText = results.map(r => r.text).join(' ');
    const combinedLinks = [];
    const seenUrls = new Set();
    
    results.forEach(result => {
      if (result.links) {
        result.links.forEach(link => {
          if (!seenUrls.has(link.url)) {
            seenUrls.add(link.url);
            combinedLinks.push(link);
          }
        });
      }
    });
    
    const jsonResult = results.find(r => r.type === 'json');
    const totalJobScore = results.reduce((sum, r) => sum + (r.jobScore?.total || 0), 0);
    const totalJobLinks = combinedLinks.filter(l => this.isJobURL(l.url)).length;
    
    const dict = this.getDictionary();
    
    return {
      url: originalUrl,
      title: 'Combined results',
      text: combinedText,
      links: combinedLinks,
      jsonData: jsonResult ? jsonResult.data : null,
      variants: results.map(r => ({ 
        type: r.type, 
        variant: r.variant,
        jobScore: r.jobScore,
        jobLinksCount: r.jobLinksCount || 0
      })),
      jobScore: this.calculateJobScore(combinedText),
      totalJobScore: totalJobScore,
      jobLinksCount: totalJobLinks,
      language: dict.getCurrentLanguage(),
      scrapedAt: new Date().toISOString(),
      method: this.name
    };
  }
}

module.exports = LightweightVariantsStep;