const config = require('../config');

const IntelligentInteractionMixin = {
  async handleShowMoreIntelligently(page, dictionary, maxAttempts = 5) {
    const validator = require('./smartElementValidator');
    let attempts = 0;
    
    while (attempts < maxAttempts) {
      const buttons = await validator.findValidShowMoreButtons(page, dictionary, 2);
      if (buttons.length === 0) break;
      
      let success = false;
      for (const button of buttons) {
        const element = await page.$(button.selector);
        if (element) {
          const result = await validator.validateAndClick(page, element);
          if (result.success) {
            success = true;
            break;
          }
        }
      }
      
      if (!success) break;
      attempts++;
    }
    
    return attempts;
  },
  
  async handleCookiesIntelligently(page, dictionary) {
    if (!dictionary) {
      config.smartLog('fail', 'No dictionary provided for cookie handling');
      return false;
    }
    
    const cookieSelectors = dictionary.cookieSelectors || [];
    const cookieTextSelectors = dictionary.cookieTextSelectors || [];
    
    return await page.evaluate((selectors, textSelectors) => {
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (el.offsetParent) {
            el.click();
            return true;
          }
        }
      }
      
      const buttons = document.querySelectorAll('button, a, div[role="button"], span[role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent.toLowerCase().trim();
        if (textSelectors.some(t => {
          if (typeof t === 'string') {
            return text === t.toLowerCase() || text.includes(t.toLowerCase());
          } else if (t instanceof RegExp) {
            return t.test(text);
          }
          return false;
        })) {
          if (text.length < 25 && btn.offsetParent) {
            btn.click();
            return true;
          }
        }
      }
      
      return false;
    }, cookieSelectors, cookieTextSelectors);
  },

  async handlePaginationIntelligently(page, dictionary, maxPages = 5) {
    if (!dictionary) {
      config.smartLog('fail', 'No dictionary provided for pagination handling');
      return 0;
    }

    const paginationSelectors = dictionary.paginationSelectors || [];
    const paginationTextSelectors = dictionary.paginationTextSelectors || [];
    let pagesProcessed = 0;

    while (pagesProcessed < maxPages) {
      const hasNextPage = await page.evaluate((selectors, textSelectors) => {
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            if (el.offsetParent && !el.disabled && !el.classList.contains('disabled')) {
              el.click();
              return true;
            }
          }
        }

        const buttons = document.querySelectorAll('button, a, div[role="button"], span[role="button"]');
        for (const btn of buttons) {
          const text = btn.textContent.toLowerCase().trim();
          if (textSelectors.some(t => {
            if (typeof t === 'string') {
              return text === t.toLowerCase() || text.includes(t.toLowerCase());
            } else if (t instanceof RegExp) {
              return t.test(text);
            }
            return false;
          })) {
            if (text.length < 25 && btn.offsetParent && !btn.disabled && !btn.classList.contains('disabled')) {
              btn.click();
              return true;
            }
          }
        }

        return false;
      }, paginationSelectors, paginationTextSelectors);

      if (!hasNextPage) break;

      await page.waitForTimeout(2000);
      
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
      } catch (e) {
        config.smartLog('steps', 'Network idle timeout during pagination');
      }

      pagesProcessed++;
    }

    return pagesProcessed;
  },

  async handleGenericInteractions(page, dictionary, options = {}) {
    if (!dictionary) {
      config.smartLog('fail', 'No dictionary provided for generic interactions');
      return { cookies: false, showMore: 0, pagination: 0 };
    }

    const results = {
      cookies: false,
      showMore: 0,
      pagination: 0
    };

    try {
      results.cookies = await this.handleCookiesIntelligently(page, dictionary);
      
      if (options.handleShowMore !== false) {
        results.showMore = await this.handleShowMoreIntelligently(page, dictionary, options.maxShowMore || 3);
      }

      if (options.handlePagination !== false) {
        results.pagination = await this.handlePaginationIntelligently(page, dictionary, options.maxPages || 2);
      }

    } catch (error) {
      config.smartLog('fail', `Error in generic interactions: ${error.message}`);
    }

    return results;
  },

  async waitForContentLoad(page, dictionary, timeout = 10000) {
    if (!dictionary) {
      config.smartLog('fail', 'No dictionary provided for content loading');
      return false;
    }

    const loadingIndicators = dictionary.loadingIndicators || [];
    const jobListingSelectors = dictionary.jobListingSelectors || [];

    try {
      await page.waitForFunction((loadingSelectors, jobSelectors) => {
        const hasLoadingIndicators = loadingSelectors.some(selector => {
          try {
            const elements = document.querySelectorAll(selector);
            return Array.from(elements).some(el => el.offsetParent !== null);
          } catch (e) {
            return false;
          }
        });

        if (hasLoadingIndicators) return false;

        const hasJobContent = jobSelectors.some(selector => {
          try {
            const elements = document.querySelectorAll(selector);
            return elements.length > 0;
          } catch (e) {
            return false;
          }
        });

        return hasJobContent || document.readyState === 'complete';
      }, loadingIndicators, jobListingSelectors, { timeout });

      return true;
    } catch (error) {
      config.smartLog('steps', 'Timeout waiting for content load, continuing anyway');
      return false;
    }
  }
};

module.exports = IntelligentInteractionMixin;