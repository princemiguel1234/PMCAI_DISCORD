import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSearch } from '../src/search.js';

test('searches explicit research and source requests', () => {
  assert.equal(shouldSearch('Please search for the official source.'), true);
  assert.equal(shouldSearch('Fact-check this and cite sources.'), true);
});

test('searches questions that depend on current information', () => {
  assert.equal(shouldSearch('What is the latest Node.js release?'), true);
  assert.equal(shouldSearch('Check the current price now.'), true);
});

test('does not search for ordinary conversation or static explanations', () => {
  assert.equal(shouldSearch('Hey PMC_AI, how are you?'), false);
  assert.equal(shouldSearch('Explain what a variable is in JavaScript.'), false);
  assert.equal(shouldSearch('What is 25 times 4?'), false);
});
