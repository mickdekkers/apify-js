import _ from 'underscore';
import { checkParamOrThrow } from 'apify-client/build/utils';

// We use weak maps here so that the content gets discarted after page gets closed.
const pageInterceptRequestHandlersMap = new WeakMap(); // Maps page to an array of request interception handlers.
const pageInterceptRequestMasterHandlerMap = new WeakMap(); // Maps page to master request interception handler.

/**
 * Executes an array for given intercept request handlers for a given request object.
 *
 * @param {Request} request Puppeteer's Request object.
 * @param {Array} interceptRequestHandlers An array of intercept request handlers.
 * @ignore
 */
const handleRequest = (request, interceptRequestHandlers) => {
    let wasAborted = false;
    let wasResponded = false;
    let wasContinued = false;

    const originalContinue = request.continue.bind(request);
    request.continue = () => {
        wasContinued = true;
    };

    request.abort = _.wrap(request.abort.bind(request), (abort, ...args) => {
        wasAborted = true;

        return abort(...args);
    });

    request.respond = _.wrap(request.respond.bind(request), (respond, ...args) => {
        wasResponded = false;

        return respond(...args);
    });

    _.some(interceptRequestHandlers, (handler) => {
        wasContinued = false;

        handler(request);

        // Check that one of the functions was called.
        if (!wasAborted && !wasResponded && !wasContinued) {
            throw new Error('Intercept request handler must call one of request.continue|respond|abort() methods!');
        }

        // If request was aborted or responded then we can finish immediately.
        return wasAborted || wasResponded;
    });

    if (!wasAborted && !wasResponded) originalContinue();
};

/**
 * Adds request interception handler in similar as `page.on('request', handler);` but in addition to that
 * supports multiple parallel handlers.
 *
 * @param {Page} page
 *   Puppeteer <a href="https://pptr.dev/#?product=Puppeteer&show=api-class-page" target="_blank"><code>Page</code></a> object.
 * @param {Function} middleware Request interception handler. See @TODO for more information.
 * @return {Promise<undefined>}
 */
export const addInterceptRequestHandler = async (page, handler) => {
    checkParamOrThrow(page, 'page', 'Object');
    checkParamOrThrow(handler, 'handler', 'Function');

    // We haven't initiated an array of handlers yet.
    if (!pageInterceptRequestHandlersMap.has(page)) {
        pageInterceptRequestHandlersMap.set(page, []);
    }

    const handlersArray = pageInterceptRequestHandlersMap.get(page);
    handlersArray.push(handler);

    // First handler was just added at this point so we need to set up request interception.
    if (handlersArray.length === 1) {
        await page.setRequestInterception(true);

        // This is a handler that get's set in page.on('request', ...) and that executes all the user
        // added custom handlers.
        const masterHandler = request => handleRequest(request, pageInterceptRequestHandlersMap.get(page));

        pageInterceptRequestMasterHandlerMap.set(page, masterHandler);
        page.on('request', masterHandler);
    }
};

/**
 * Removes request interception handler for given page.
 *
 * @param {Page} page
 *   Puppeteer <a href="https://pptr.dev/#?product=Puppeteer&show=api-class-page" target="_blank"><code>Page</code></a> object.
 * @param {Function} middleware Request interception handler. See @TODO for more information.
 * @return {Promise<undefined>}
 */
export const removeInterceptRequestHandler = async (page, handler) => {
    const handlersArray = pageInterceptRequestHandlersMap
        .get(page)
        .filter(item => item !== handler);

    pageInterceptRequestHandlersMap.set(page, handlersArray);

    // There are no more handlers so we can't turn off request interception and remove master handler.
    if (handlersArray.length === 0) {
        await page.setRequestInterception(false);
        const requestHandler = pageInterceptRequestMasterHandlerMap.get(page);
        page.removeListener('request', requestHandler);
    }
};
