import { test, expect } from 'bun:test';
import { TaskPool } from './pool.js';

test('TaskPool concurrency limit of 1 runs tasks sequentially', async () => {
  const pool = new TaskPool(1);
  const executionOrder: number[] = [];

  const task1 = () =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        executionOrder.push(1);
        resolve();
      }, 50);
    });

  const task2 = () =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        executionOrder.push(2);
        resolve();
      }, 10);
    });

  pool.enqueue(task1);
  pool.enqueue(task2);

  await pool.waitForCompletion();

  expect(executionOrder).toEqual([1, 2]);
});

test('TaskPool concurrency limit of 2 runs tasks concurrently', async () => {
  const pool = new TaskPool(2);
  const executionOrder: number[] = [];

  const task1 = () =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        executionOrder.push(1);
        resolve();
      }, 50);
    });

  const task2 = () =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        executionOrder.push(2);
        resolve();
      }, 10);
    });

  pool.enqueue(task1);
  pool.enqueue(task2);

  await pool.waitForCompletion();

  // Task 2 finishes faster than Task 1 even though Task 1 started first,
  // because they run concurrently.
  expect(executionOrder).toEqual([2, 1]);
});
