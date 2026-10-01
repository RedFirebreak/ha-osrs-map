/** An element with a class and, when given, text (as text: nothing in it is read as HTML). */
export function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
