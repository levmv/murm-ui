import assert from "node:assert/strict";
import { test } from "node:test";
import { type DOMWindow, JSDOM } from "jsdom";
import { AppRouter } from "./router";

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function installDom(url: string): DOMWindow {
	const dom = new JSDOM("", { url });
	setGlobal("window", dom.window);
	setGlobal("history", dom.window.history);
	setGlobal("location", dom.window.location);
	return dom.window;
}

test("hash router reads, writes, and stops listening after destroy", () => {
	const window = installDom("https://example.test/#/chat/current");
	const router = new AppRouter();
	const navigations: (string | null)[] = [];

	assert.equal(router.getId(), "current");
	assert.equal(router.hrefFor("next"), "#/chat/next");

	router.setUrl("next");
	assert.equal(window.location.hash, "#/chat/next");

	router.listen((id) => navigations.push(id));
	window.location.hash = "#/chat/from-event";
	window.dispatchEvent(new window.HashChangeEvent("hashchange"));
	assert.deepEqual(navigations, ["from-event"]);

	window.history.pushState(null, "", "#/chat/from-popstate");
	window.dispatchEvent(new window.PopStateEvent("popstate"));
	assert.deepEqual(navigations, ["from-event", "from-popstate"]);

	router.destroy();
	window.location.hash = "#/chat/ignored";
	window.dispatchEvent(new window.HashChangeEvent("hashchange"));
	window.history.pushState(null, "", "#/chat/also-ignored");
	window.dispatchEvent(new window.PopStateEvent("popstate"));
	assert.deepEqual(navigations, ["from-event", "from-popstate"]);
});

test("path router reads, writes, and reports popstate navigation", () => {
	const window = installDom("https://example.test/c/current");
	const router = new AppRouter({ type: "path" });
	const navigations: (string | null)[] = [];

	assert.equal(router.getId(), "current");
	assert.equal(router.hrefFor("next"), "/c/next");

	router.setUrl("next");
	assert.equal(window.location.pathname, "/c/next");

	router.listen((id) => navigations.push(id));
	window.history.pushState(null, "", "/c/from-popstate");
	window.dispatchEvent(new window.PopStateEvent("popstate"));
	assert.deepEqual(navigations, ["from-popstate"]);

	router.setUrl(null, true);
	assert.equal(window.location.pathname, "/");
});

test("disabled router leaves the URL alone", () => {
	const window = installDom("https://example.test/#/chat/current");
	const router = new AppRouter({ type: "none" });
	let called = false;

	assert.equal(router.getId(), null);
	assert.equal(router.hrefFor("next"), "#");

	router.listen(() => {
		called = true;
	});
	router.setUrl("next");
	window.dispatchEvent(new window.HashChangeEvent("hashchange"));

	assert.equal(window.location.href, "https://example.test/#/chat/current");
	assert.equal(called, false);
});
