const config = require('../config');

class SmartElementValidator {
  static isValidShowMoreButton(element, page, dictionary) {
    if (!dictionary) {
      config.smartLog('alert', 'No dictionary provided for show more validation');
      return Promise.resolve(false);
    }

    const showMoreTextSelectors = dictionary.showMoreTextSelectors || [];
    
    return page.evaluate((el, textSelectors) => {
      if (!el || !el.offsetParent) return false;
      
      const text = (el.textContent || '').trim().toLowerCase();
      const tagName = el.tagName.toLowerCase();
      const isClickable = ['button', 'a', 'input'].includes(tagName) || 
                         el.hasAttribute('onclick') || 
                         el.getAttribute('role') === 'button';
      
      if (!isClickable) return false;
      
      if (text.length === 0 || text.length > 50) return false;
      
      const isShowMoreText = textSelectors.some(pattern => {
        if (typeof pattern === 'string') {
          return text === pattern.toLowerCase() || text.includes(pattern.toLowerCase());
        } else if (pattern instanceof RegExp) {
          return pattern.test(text);
        }
        return false;
      });
      
      const hasPositiveKeywords = /\b(show|load|view|see|expand|more|all|plus|davantage|charger|voir|afficher|más|mostrar|cargar|mehr|zeigen|laden|di più|mostra|carica|meer|toon|laad|fler|visa|ladda|flere|vis|last|lisää|näytä|lataa|більше|показати|завантажити)\b/i.test(text);
      const hasNegativeKeywords = /\b(expand all|collapse|hide|less|fewer|masquer|cacher|moins|ocultar|menos|verstecken|weniger|nascondere|meno|verbergen|minder|dölja|färre|skjul|piilota|vähemmän|приховати|менше)\b/i.test(text);
      
      return (isShowMoreText || hasPositiveKeywords) && !hasNegativeKeywords;
    }, element, showMoreTextSelectors);
  }
  
  static async findValidShowMoreButtons(page, dictionary, limit = 5) {
    if (!dictionary) {
      config.smartLog('alert', 'No dictionary provided for finding show more buttons');
      return [];
    }

    const showMoreSelectors = dictionary.showMoreSelectors || [];
    const showMoreTextSelectors = dictionary.showMoreTextSelectors || [];
    
    return await page.evaluate((selectors, textSelectors, limit) => {
      const elements = [];
      const processedTexts = new Set();
      
      for (const selector of selectors) {
        try {
          const selectorElements = document.querySelectorAll(selector);
          for (const el of selectorElements) {
            if (elements.length >= limit) break;
            
            const text = (el.textContent || '').trim().toLowerCase();
            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0 && 
                             el.offsetParent !== null &&
                             window.getComputedStyle(el).display !== 'none';
            
            if (!isVisible || processedTexts.has(text)) continue;
            
            const isShowMoreText = textSelectors.some(pattern => {
              if (typeof pattern === 'string') {
                return text === pattern.toLowerCase() || text.includes(pattern.toLowerCase());
              } else if (pattern instanceof RegExp) {
                return pattern.test(text);
              }
              return false;
            });
            
            const hasValidKeywords = /\b(show|load|view|see|expand|more|all|plus|davantage|charger|voir|afficher|más|mostrar|cargar|mehr|zeigen|laden|di più|mostra|carica|meer|toon|laad|fler|visa|ladda|flere|vis|last|lisää|näytä|lataa|більше|показати|завантажити)\b/i.test(text);
            const validLength = text.length > 2 && text.length < 30;
            
            if (validLength && (isShowMoreText || hasValidKeywords)) {
              processedTexts.add(text);
              
              let elementSelector = el.tagName.toLowerCase();
              if (el.id) elementSelector += `#${el.id}`;
              else if (el.className) elementSelector += `.${el.className.split(' ')[0]}`;
              
              elements.push({
                selector: elementSelector,
                text: el.textContent.trim(),
                xpath: getXPath(el)
              });
            }
          }
        } catch (e) {
        }
      }
      
      const allButtons = document.querySelectorAll('button, a[role="button"], [onclick], input[type="button"], input[type="submit"]');
      
      for (const el of allButtons) {
        if (elements.length >= limit) break;
        
        const text = (el.textContent || '').trim().toLowerCase();
        const rect = el.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0 && 
                         el.offsetParent !== null &&
                         window.getComputedStyle(el).display !== 'none';
        
        if (!isVisible || processedTexts.has(text)) continue;
        
        const isShowMoreText = textSelectors.some(pattern => {
          if (typeof pattern === 'string') {
            return text === pattern.toLowerCase() || text.includes(pattern.toLowerCase());
          } else if (pattern instanceof RegExp) {
            return pattern.test(text);
          }
          return false;
        });
        
        const showMorePatterns = /^(show|load|view|see|expand|afficher|charger|voir|mostrar|cargar|zeigen|laden|mostra|carica|toon|laad|visa|ladda|vis|last|näytä|lataa|показати|завантажити)\s+(more|all|plus|davantage|tous|más|todo|mehr|alle|di più|tutto|meer|alles|fler|alla|flere|alle|lisää|kaikki|більше|все)|^(expand|more|plus|davantage|más|mehr|di più|meer|fler|flere|lisää|більше)$/i;
        const validLength = text.length > 2 && text.length < 30;
        
        if (validLength && (isShowMoreText || showMorePatterns.test(text))) {
          processedTexts.add(text);
          
          let elementSelector = el.tagName.toLowerCase();
          if (el.id) elementSelector += `#${el.id}`;
          else if (el.className) elementSelector += `.${el.className.split(' ')[0]}`;
          
          elements.push({
            selector: elementSelector,
            text: el.textContent.trim(),
            xpath: getXPath(el)
          });
        }
      }
      
      function getXPath(element) {
        if (element.id) return `//*[@id="${element.id}"]`;
        
        const parts = [];
        while (element && element.nodeType === Node.ELEMENT_NODE) {
          let index = 0;
          let sibling = element.previousSibling;
          while (sibling) {
            if (sibling.nodeType === Node.ELEMENT_NODE && 
                sibling.nodeName === element.nodeName) {
              index++;
            }
            sibling = sibling.previousSibling;
          }
          const part = element.nodeName.toLowerCase() + (index > 0 ? `[${index + 1}]` : '');
          parts.unshift(part);
          element = element.parentNode;
        }
        return parts.length ? '/' + parts.join('/') : null;
      }
      
      return elements;
    }, showMoreSelectors, showMoreTextSelectors, limit);
  }

  static async findValidPaginationButtons(page, dictionary, limit = 3) {
    if (!dictionary) {
      config.smartLog('alert', 'No dictionary provided for finding pagination buttons');
      return [];
    }

    const paginationSelectors = dictionary.paginationSelectors || [];
    const paginationTextSelectors = dictionary.paginationTextSelectors || [];
    
    return await page.evaluate((selectors, textSelectors, limit) => {
      const elements = [];
      const processedTexts = new Set();
      
      for (const selector of selectors) {
        try {
          const selectorElements = document.querySelectorAll(selector);
          for (const el of selectorElements) {
            if (elements.length >= limit) break;
            
            const text = (el.textContent || '').trim().toLowerCase();
            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0 && 
                             el.offsetParent !== null &&
                             window.getComputedStyle(el).display !== 'none' &&
                             !el.disabled && !el.classList.contains('disabled');
            
            if (!isVisible || processedTexts.has(text)) continue;
            
            const isPaginationText = textSelectors.some(pattern => {
              if (typeof pattern === 'string') {
                return text === pattern.toLowerCase() || text.includes(pattern.toLowerCase());
              } else if (pattern instanceof RegExp) {
                return pattern.test(text);
              }
              return false;
            });
            
            if (isPaginationText) {
              processedTexts.add(text);
              
              let elementSelector = el.tagName.toLowerCase();
              if (el.id) elementSelector += `#${el.id}`;
              else if (el.className) elementSelector += `.${el.className.split(' ')[0]}`;
              
              elements.push({
                selector: elementSelector,
                text: el.textContent.trim(),
                xpath: getXPath(el)
              });
            }
          }
        } catch (e) {
        }
      }
      
      function getXPath(element) {
        if (element.id) return `//*[@id="${element.id}"]`;
        
        const parts = [];
        while (element && element.nodeType === Node.ELEMENT_NODE) {
          let index = 0;
          let sibling = element.previousSibling;
          while (sibling) {
            if (sibling.nodeType === Node.ELEMENT_NODE && 
                sibling.nodeName === element.nodeName) {
              index++;
            }
            sibling = sibling.previousSibling;
          }
          const part = element.nodeName.toLowerCase() + (index > 0 ? `[${index + 1}]` : '');
          parts.unshift(part);
          element = element.parentNode;
        }
        return parts.length ? '/' + parts.join('/') : null;
      }
      
      return elements;
    }, paginationSelectors, paginationTextSelectors, limit);
  }
  
  static async validateAndClick(page, element, timeout = 5000) {
    try {
      const beforeHeight = await page.evaluate(() => document.body.scrollHeight);
      const beforeContent = await page.evaluate(() => document.body.textContent.length);
      
      await element.click();
      await page.waitForTimeout(2000);
      
      const afterHeight = await page.evaluate(() => document.body.scrollHeight);
      const afterContent = await page.evaluate(() => document.body.textContent.length);
      
      const contentIncreased = afterHeight > beforeHeight || afterContent > beforeContent * 1.1;
      
      return {
        success: contentIncreased,
        heightDiff: afterHeight - beforeHeight,
        contentDiff: afterContent - beforeContent
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  static async findJobListings(page, dictionary, options = {}) {
    if (!dictionary) {
      config.smartLog('alert', 'No dictionary provided for finding job listings');
      return [];
    }

    const jobListingSelectors = dictionary.jobListingSelectors || [];
    const jobTerms = dictionary.jobTerms || [];
    
    return await page.evaluate((selectors, terms, opts) => {
      const elements = [];
      const seenTexts = new Set();
      const limit = opts.limit || 50;
      
      for (const selector of selectors) {
        try {
          const selectorElements = document.querySelectorAll(selector);
          for (const el of selectorElements) {
            if (elements.length >= limit) break;
            
            const text = (el.textContent || '').trim();
            const rect = el.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0 && 
                             el.offsetParent !== null;
            
            if (!isVisible || seenTexts.has(text) || text.length < 5) continue;
            
            const hasJobTerms = terms.some(term => 
              text.toLowerCase().includes(term.toLowerCase())
            );
            
            if (hasJobTerms || text.length > 10) {
              seenTexts.add(text);
              
              const links = el.querySelectorAll('a[href]');
              const primaryLink = links.length > 0 ? links[0].href : '';
              
              elements.push({
                text: text.substring(0, 200),
                url: primaryLink,
                selector: selector,
                hasJobTerms: hasJobTerms
              });
            }
          }
        } catch (e) {
        }
      }
      
      return elements;
    }, jobListingSelectors, jobTerms, options);
  }
}

module.exports = SmartElementValidator;