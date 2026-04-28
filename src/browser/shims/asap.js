export default function asap(task) {
  queueMicrotask(task);
}
