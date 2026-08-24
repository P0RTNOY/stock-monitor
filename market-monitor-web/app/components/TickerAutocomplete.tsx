'use client';

import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { isTickerSuggestion, type TickerSuggestion } from '../lib/tickers';

type Props = {
  value: string;
  disabled?: boolean;
  allowedSymbols?: string[];
  emptyMessage?: string;
  onChange: (value: string) => void;
  onSelect: (suggestion: TickerSuggestion) => void;
};

export default function TickerAutocomplete({ value, disabled, allowedSymbols, emptyMessage, onChange, onSelect }: Props) {
  const listboxId = useId();
  const [suggestions, setSuggestions] = useState<TickerSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [searchedQuery, setSearchedQuery] = useState('');
  const query = value.trim();
  const open = focused && query.length >= 2
    && (loading || error || suggestions.length > 0 || searchedQuery === query);

  useEffect(() => {
    if (query.length < 2) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(false);
      setSearchedQuery('');
      try {
        const response = await fetch(`/api/market/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Ticker search failed');
        const payload = await response.json() as { results?: unknown };
        if (controller.signal.aborted) return;
        const allowed = allowedSymbols ? new Set(allowedSymbols) : null;
        const results = Array.isArray(payload.results)
          ? payload.results.filter(isTickerSuggestion).filter((suggestion) => !allowed || allowed.has(suggestion.symbol))
          : [];
        setSuggestions(results);
        setActiveIndex(results.length ? 0 : -1);
        setSearchedQuery(query);
      } catch {
        if (controller.signal.aborted) return;
        setSuggestions([]);
        setActiveIndex(-1);
        setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [allowedSymbols, query]);

  const choose = (suggestion: TickerSuggestion) => {
    onChange(suggestion.symbol);
    onSelect(suggestion);
    setSuggestions([]);
    setActiveIndex(-1);
    setFocused(false);
  };

  const handleChange = (input: string) => {
    const nextValue = input.toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 10);
    setSuggestions([]);
    setActiveIndex(-1);
    setLoading(false);
    setError(false);
    setSearchedQuery('');
    onChange(nextValue);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open || !suggestions.length) {
      if (event.key === 'Escape') setFocused(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => current <= 0 ? suggestions.length - 1 : current - 1);
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      choose(suggestions[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setFocused(false);
    }
  };

  return <div className="ticker-autocomplete">
    <input
      name="symbol"
      value={value}
      placeholder="Start typing a ticker"
      required
      maxLength={10}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listboxId}
      aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => window.setTimeout(() => setFocused(false), 100)}
      onKeyDown={handleKeyDown}
      onChange={(event) => handleChange(event.target.value)}
    />
    {open && <div className="ticker-suggestions" id={listboxId} role="listbox" aria-label="Matching stocks">
      {loading && <p role="status">Searching the real ticker directory…</p>}
      {!loading && error && <p role="status">Ticker search is unavailable. Try again in a moment.</p>}
      {!loading && !error && searchedQuery === query && !suggestions.length
        && <p role="status">{emptyMessage ?? 'No matching stocks or ETFs found.'}</p>}
      {!loading && !error && suggestions.map((suggestion, index) => <button
        type="button"
        role="option"
        aria-selected={index === activeIndex}
        id={`${listboxId}-${index}`}
        className={index === activeIndex ? 'active' : ''}
        key={`${suggestion.symbol}-${suggestion.exchange}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(suggestion)}
      >
        <span><strong>{suggestion.symbol}</strong><small>{suggestion.companyName}</small></span>
        <em>{suggestion.exchange} · {suggestion.quoteType}</em>
      </button>)}
    </div>}
  </div>;
}
