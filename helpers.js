const cheerio = require('cheerio');
const { randomDelay, getRandomUserAgent } = require('../utils');
const dictionaries = require('../dictionaries');
const config = require('../config');

const extractContentFromCheerio = ($, url) => {
  try {
    const bodyClone = $('body').clone();
    bodyClone.find('script, style, noscript, iframe, svg').remove();
    
    const pageText = bodyClone.text().replace(/\s+/g, ' ').trim();
    const pageTitle = $('title').text().trim() || $('h1').first().text().trim() || '';
    
    const links = [];
    const seenUrls = new Set();
    
    $('a').each((i, el) => {
      try {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        
        if (!href || !text || href.startsWith('#') || href.startsWith('javascript:')) {
          return;
        }
        
        let fullUrl = href;
        if (href.startsWith('/')) {
          const urlObj = new URL(url);
          fullUrl = `${urlObj.protocol}//${urlObj.host}${href}`;
        } else if (!href.startsWith('http')) {
          try {
            fullUrl = new URL(href, url).href;
          } catch (e) {
            return;
          }
        }
        
        if (!seenUrls.has(fullUrl)) {
          seenUrls.add(fullUrl);
          links.push({
            url: fullUrl,
            text: text.substring(0, 200)
          });
        }
      } catch (e) {}
    });
    
    return {
      title: pageTitle,
      text: pageText,
      links: links
    };
  } catch (error) {
    config.smartLog('fail', `extractContentFromCheerio error: ${error.message}`, {
      url: url || 'unknown',
      stackTrace: error.stack
    });
    return {
      title: '',
      text: $.text() || '',
      links: []
    };
  }
};

const isJobRelatedLink = (url, text, $, element) => {
  const urlLower = url.toLowerCase();
  const textLower = text.toLowerCase();
  
  const jobURLPatterns = dictionaries.jobURLPatterns;
  const jobTerms = dictionaries.jobTerms;
  const jobListingSelectors = dictionaries.jobListingSelectors;
  
  const urlMatches = jobURLPatterns.some(pattern => pattern.test(urlLower));
  const textMatches = jobTerms.some(term => textLower.includes(term.toLowerCase()));
  
  const $el = $(element);
  const hasJobClass = jobListingSelectors.some(selector => {
    try {
      if (!selector || selector.includes('[*]')) return false;
      if (selector.split('[').length !== selector.split(']').length) return false;
      
      return $el.is(selector) || $el.closest(selector).length > 0;
    } catch (e) {
      return false;
    }
  });
  
  const isInJobSection = (() => {
    try {
      const validSelectors = [
        '[class*="job"]', 
        '[class*="career"]', 
        '[id*="job"]', 
        '[id*="career"]'
      ].filter(sel => sel.split('[').length === sel.split(']').length);
      
      return $el.closest(validSelectors.join(', ')).length > 0;
    } catch {
      return false;
    }
  })();
  
  return urlMatches || textMatches || hasJobClass || isInJobSection;
};

const determineLinkType = (url, text, $, element) => {
  const urlLower = url.toLowerCase();
  const textLower = text.toLowerCase();
  const $el = $(element);
  
  const jobNavigationSelectors = dictionaries.jobNavigationSelectors;
  const paginationSelectors = dictionaries.paginationSelectors;
  const paginationPatterns = dictionaries.paginationPatterns;
  const showMoreSelectors = dictionaries.showMoreSelectors;
  const showMorePatterns = dictionaries.showMorePatterns;
  const jobListingSelectors = dictionaries.jobListingSelectors;
  const jobURLPatterns = dictionaries.jobURLPatterns;
  
  const isCareerNavigation = jobNavigationSelectors.some(selector => {
    try {
      return $el.is(selector);
    } catch (e) {
      return false;
    }
  });
  
  if (isCareerNavigation) return 'career_navigation';
  
  const isPagination = paginationSelectors.some(selector => {
    try {
      return $el.is(selector);
    } catch (e) {
      return false;
    }
  }) || paginationPatterns.regex.test(textLower);
  
  if (isPagination) return 'pagination';
  
  const isShowMore = showMoreSelectors.some(selector => {
    try {
      return $el.is(selector);
    } catch (e) {
      return false;
    }
  }) || showMorePatterns.regex.test(textLower);
  
  if (isShowMore) return 'show_more';
  
  const isJobListing = jobListingSelectors.some(selector => {
    try {
      return $el.is(selector) || $el.closest(selector).length > 0;
    } catch (e) {
      return false;
    }
  });
  
  if (isJobListing) return 'job_listing';
  
  if (jobURLPatterns.some(pattern => pattern.test(urlLower))) {
    return 'job_posting';
  }
  
  return 'generic';
};

const calculateLinkConfidence = (url, text, isJobRelated) => {
  let confidence = 0;
  
  if (isJobRelated) confidence += 0.3;
  
  const urlLower = url.toLowerCase();
  const textLower = text.toLowerCase();
  
  const jobURLPatterns = dictionaries.jobURLPatterns;
  const jobTerms = dictionaries.jobTerms;
  
  const exactJobPatterns = jobURLPatterns.filter(pattern => 
    pattern.source.includes('job') || pattern.source.includes('career')
  );
  
  if (exactJobPatterns.some(pattern => pattern.test(urlLower))) {
    confidence += 0.4;
  }
  
  const jobTermMatches = jobTerms.filter(term => 
    textLower.includes(term.toLowerCase())
  ).length;
  
  confidence += Math.min(jobTermMatches * 0.1, 0.3);
  
  if (/\/\d+$/.test(url) || /[?&]id=/.test(url)) {
    confidence += 0.2;
  }
  
  return Math.min(confidence, 1.0);
};

const prioritizeLinks = (links) => {
  const priorityOrder = {
    'job_posting': 5,
    'job_listing': 4,
    'career_navigation': 3,
    'show_more': 2,
    'pagination': 1,
    'generic': 0
  };
  
  return links
    .sort((a, b) => {
      const priorityDiff = (priorityOrder[b.linkType] || 0) - (priorityOrder[a.linkType] || 0);
      if (priorityDiff !== 0) return priorityDiff;
      
      return b.confidence - a.confidence;
    })
    .slice(0, 500);
};

const analyzePageContext = ($, url) => {
  const urlLower = url.toLowerCase();
  const pageText = $('body').text().toLowerCase();
  const pageTitle = $('title').text().toLowerCase();
  
  const knownJobPlatforms = dictionaries.knownJobPlatforms;
  const complexDomains = dictionaries.complexDomains;
  const jobURLPatterns = dictionaries.jobURLPatterns;
  const jobListingSelectors = dictionaries.jobListingSelectors;
  const paginationSelectors = dictionaries.paginationSelectors;
  const showMoreSelectors = dictionaries.showMoreSelectors;
  
  let platform = null;
  for (const platformInfo of knownJobPlatforms) {
    if (platformInfo.patterns.some(pattern => urlLower.includes(pattern.toLowerCase()))) {
      platform = platformInfo.name;
      break;
    }
    
    if (platformInfo.indicators.some(indicator => 
      pageText.includes(indicator.toLowerCase()) || 
      $(`[class*="${indicator}"], [id*="${indicator}"]`).length > 0
    )) {
      platform = platformInfo.name;
      break;
    }
  }
  
  const isComplexDomain = complexDomains.some(domain => 
    urlLower.includes(domain.toLowerCase())
  );
  
  let pageType = 'unknown';
  if (jobURLPatterns.some(pattern => pattern.test(urlLower))) {
    pageType = 'job_page';
  } else if (/career|job|employ/i.test(pageTitle) || /career|job|employ/i.test(urlLower)) {
    pageType = 'career_page';
  } else {
    pageType = 'general_page';
  }
  
  const hasJobListings = jobListingSelectors.some(selector => {
    try {
      return $(selector).length > 0;
    } catch (e) {
      return false;
    }
  });
  
  const hasPagination = paginationSelectors.some(selector => {
    try {
      return $(selector).length > 0;
    } catch (e) {
      return false;
    }
  });
  
  const hasShowMore = showMoreSelectors.some(selector => {
    try {
      return $(selector).length > 0;
    } catch (e) {
      return false;
    }
  });
  
  return {
    pageType,
    platform,
    isComplexDomain,
    hasJobListings,
    hasPagination,
    hasShowMore
  };
};

const findJobMatches = (pageData, jobTitles, locations = []) => {
  if (!pageData || !pageData.text) {
    return { jobTitles: [], locations: [], links: [], priority: 0, pageInfo: null };
  }
  
  const jobTerms = dictionaries.jobTerms;
  
  const pageTextLower = pageData.text.toLowerCase();
  const pageTitleLower = (pageData.title || '').toLowerCase();
  
  const matches = {
    jobTitles: [],
    locations: [],
    links: [],
    priority: 0,
    pageInfo: {
      pageType: pageData.pageType,
      platform: pageData.platform,
      hasJobListings: pageData.hasJobListings,
      hasPagination: pageData.hasPagination,
      hasShowMore: pageData.hasShowMore
    }
  };
  
  const jobSectionRegex = /(?:job|career|position|opening|vacancy|emploi|poste|trabajo|stelle|lavoro)s?\s*(?:list|listing|opportunities|openings|disponibles|ouvertes)/i;
  const isJobPage = jobSectionRegex.test(pageTextLower) || 
                   jobSectionRegex.test(pageTitleLower) || 
                   pageData.pageType === 'job_page' || 
                   pageData.hasJobListings;
  
  for (const jobTitle of jobTitles) {
    const jobTitleLower = jobTitle.toLowerCase().trim();
    const jobTitleWords = jobTitleLower.split(/\s+/).filter(word => word.length > 2);
    
    if (jobTitleWords.length === 0) continue;
    
    const exactMatch = pageTextLower.includes(jobTitleLower) || pageTitleLower.includes(jobTitleLower);
    
    let hasStrictMatch = false;
    
    if (exactMatch) {
      hasStrictMatch = true;
    } else if (jobTitleWords.length >= 2) {
      const proximityDistance = Math.min(40, jobTitleWords.length * 12);
      let proximityMatch = false;
      
      for (let i = 0; i < jobTitleWords.length - 1; i++) {
        const word1 = jobTitleWords[i];
        const word2 = jobTitleWords[i + 1];
        
        const proximityRegex = new RegExp(`\\b${word1}\\b[\\s\\w]{0,${proximityDistance}}\\b${word2}\\b`, 'i');
        if (proximityRegex.test(pageTextLower)) {
          proximityMatch = true;
          break;
        }
      }
      
      if (!proximityMatch && jobTitleWords.length === 2) {
        const word1 = jobTitleWords[0];
        const word2 = jobTitleWords[1];
        const reverseProximityRegex = new RegExp(`\\b${word2}\\b[\\s\\w]{0,${proximityDistance}}\\b${word1}\\b`, 'i');
        proximityMatch = reverseProximityRegex.test(pageTextLower);
      }
      
      hasStrictMatch = proximityMatch && isJobPage;
    } else if (jobTitleWords.length === 1) {
      hasStrictMatch = pageTextLower.includes(jobTitleWords[0]) && isJobPage;
    }
    
    if (hasStrictMatch) {
      matches.jobTitles.push(jobTitle);
      
      const jobLinks = pageData.links.filter(link => {
        if (!link.text || !link.url) return false;
        
        const linkTextLower = link.text.toLowerCase();
        const linkUrlLower = link.url.toLowerCase();
        
        const isGenericLink = /^(apply|view|see|more|details|info|learn|about|contact|full[\s-]?time|part[\s-]?time|freelance|opportunity|opportunities)$/i.test(link.text.trim());
        
        const exactLinkMatch = linkTextLower.includes(jobTitleLower);
        
        if (exactLinkMatch && (link.isJobPosting || link.linkType === 'job_posting')) return true;
        
        if (!isGenericLink && jobTitleWords.length >= 2) {
          const linkProximityDistance = Math.min(25, jobTitleWords.length * 8);
          let linkProximityMatch = false;
          
          for (let i = 0; i < jobTitleWords.length - 1; i++) {
            const word1 = jobTitleWords[i];
            const word2 = jobTitleWords[i + 1];
            
            const linkProximityRegex = new RegExp(`\\b${word1}\\b[\\s\\w]{0,${linkProximityDistance}}\\b${word2}\\b`, 'i');
            if (linkProximityRegex.test(linkTextLower)) {
              linkProximityMatch = true;
              break;
            }
          }
          
          if (linkProximityMatch && (link.isJobPosting || link.linkType === 'job_posting')) return true;
        }
        
        const urlSlugVariations = [
          jobTitleLower.replace(/\s+/g, '-'),
          jobTitleLower.replace(/\s+/g, '_'),
          jobTitleLower.replace(/\s+/g, '+'),
          jobTitleLower.replace(/\s+/g, '%20')
        ];
        
        const urlContainsTitle = urlSlugVariations.some(variation => 
          linkUrlLower.includes(variation)
        );
        
        if (urlContainsTitle && !isGenericLink) return true;
        
        return false;
      });
      
      const enhancedLinks = jobLinks.map(link => ({
        ...link,
        isJobPosting: true,
        matchedJobTitle: jobTitle,
        matchConfidence: exactMatch ? 'high' : 'medium'
      }));
      
      matches.links.push(...enhancedLinks);
    }
  }
  
  if (matches.jobTitles.length > 0) {
    matches.priority = 1;
    
    if (pageData.platform) {
      matches.priority += 0.5;
    }
    
    if (pageData.hasJobListings) {
      matches.priority += 0.3;
    }
    
    if (locations && locations.length > 0) {
      for (const location of locations) {
        const locationLower = location.toLowerCase();
        
        if (pageTextLower.includes(locationLower) || pageTitleLower.includes(locationLower)) {
          matches.locations.push(location);
          
          const locationLinks = matches.links.filter(link => {
            const linkTextLower = (link.text || '').toLowerCase();
            return linkTextLower.includes(locationLower);
          });
          
          if (locationLinks.length > 0) {
            matches.priority += 0.5;
          }
        }
      }
    }
  }
  
  const uniqueLinks = [];
  const seenUrls = new Set();
  
  for (const link of matches.links) {
    if (!seenUrls.has(link.url)) {
      seenUrls.add(link.url);
      uniqueLinks.push(link);
    }
  }
  
  matches.links = uniqueLinks.sort((a, b) => (b.matchConfidence === 'high' ? 1 : 0) - (a.matchConfidence === 'high' ? 1 : 0));
  
  return matches;
};

const detectJobPlatform = (url, html) => {
  const urlLower = url.toLowerCase();
  const htmlLower = html.toLowerCase();
  
  const knownJobPlatforms = dictionaries.knownJobPlatforms;
  
  for (const platform of knownJobPlatforms) {
    const patternMatch = platform.patterns.some(pattern => urlLower.includes(pattern.toLowerCase()));
    const indicatorMatch = platform.indicators.some(indicator => htmlLower.includes(indicator.toLowerCase()));
    
    if (patternMatch || indicatorMatch) {
      return {
        name: platform.name,
        method: platform.iframeMethod ? 'iframe' : platform.directMethod ? 'direct' : 'unknown',
        apiPatterns: platform.apiPatterns || [],
        confidence: patternMatch && indicatorMatch ? 'high' : patternMatch || indicatorMatch ? 'medium' : 'low'
      };
    }
  }
  
  return null;
};

const findNavigationElements = ($) => {
  const elements = {
    showMore: [],
    pagination: [],
    careerNavigation: []
  };
  
  const showMoreSelectors = dictionaries.showMoreSelectors;
  const showMorePatterns = dictionaries.showMorePatterns;
  const paginationSelectors = dictionaries.paginationSelectors;
  const paginationPatterns = dictionaries.paginationPatterns;
  const jobNavigationSelectors = dictionaries.jobNavigationSelectors;
  const jobTerms = dictionaries.jobTerms;
  
  showMoreSelectors.forEach(selector => {
    try {
      $(selector).each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        const href = $el.attr('href') || $el.attr('data-url') || '';
        
        if (text && showMorePatterns.regex.test(text)) {
          elements.showMore.push({
            element: el,
            text: text,
            url: href,
            selector: selector
          });
        }
      });
    } catch (e) {}
  });
  
  paginationSelectors.forEach(selector => {
    try {
      $(selector).each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        const href = $el.attr('href') || '';
        
        if (href && paginationPatterns.regex.test(text)) {
          elements.pagination.push({
            element: el,
            text: text,
            url: href,
            selector: selector
          });
        }
      });
    } catch (e) {}
  });
  
  jobNavigationSelectors.forEach(selector => {
    try {
      $(selector).each((i, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        const href = $el.attr('href') || '';
        
        if (href && jobTerms.some(term => text.toLowerCase().includes(term.toLowerCase()))) {
          elements.careerNavigation.push({
            element: el,
            text: text,
            url: href,
            selector: selector
          });
        }
      });
    } catch (e) {}
  });
  
  return elements;
};

module.exports = {
  extractContentFromCheerio,
  findJobMatches,
  detectJobPlatform,
  findNavigationElements
};