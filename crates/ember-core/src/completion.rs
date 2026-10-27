//! Completion styles, as Emacs's `completion-styles`: how minibuffer input
//! matches the names it could complete to. Styles are tried in order, and
//! the first that matches anything decides.

/// The candidates that `input` matches in a completion style, or `None` for
/// a style Ember does not know.
pub fn matches_in_style(style: &str, input: &str, candidates: &[String]) -> Option<Vec<String>> {
    let test: fn(&str, &str) -> bool = match style {
        "basic" | "emacs22" => |input, c| c.starts_with(input),
        "partial-completion" => partial_match,
        "substring" => |input, c| c.contains(input),
        "flex" => flex_match,
        _ => return None,
    };
    Some(candidates.iter().filter(|c| test(input, c)).cloned().collect())
}

/// The candidates input matches, by the first of `styles` that matches any.
pub fn complete(styles: &[String], input: &str, candidates: &[String]) -> Vec<String> {
    for style in styles {
        if let Some(found) = matches_in_style(style, input, candidates)
            && !found.is_empty()
        {
            return found;
        }
    }
    Vec::new()
}

/// Whether a character separates the words partial completion completes one
/// by one: "f-f" matches "find-file".
fn is_delimiter(c: char) -> bool {
    matches!(c, '-' | '_' | '/' | '.' | ' ')
}

/// Partial completion, as Emacs's: each word of the input, up to a
/// delimiter, is a prefix of a word of the candidate, in order, and `*`
/// matches anything.
fn partial_match(input: &str, candidate: &str) -> bool {
    // Split the input into pieces that each start at a delimiter.
    let mut pieces: Vec<String> = Vec::new();
    for c in input.chars() {
        if is_delimiter(c) || c == '*' || pieces.is_empty() {
            pieces.push(String::new());
        }
        pieces.last_mut().expect("pushed").push(c);
    }
    let cand: Vec<char> = candidate.chars().collect();
    match_pieces(&pieces, &cand, 0, true)
}

/// Matches pieces against the candidate from `at`. The first piece must
/// match at the start; each later one at a matching delimiter further on.
fn match_pieces(pieces: &[String], cand: &[char], at: usize, first: bool) -> bool {
    let Some((piece, rest)) = pieces.split_first() else { return true };
    let chars: Vec<char> = piece.chars().collect();
    let (wild, chars) = match chars.first() {
        Some('*') => (true, &chars[1..]),
        _ => (false, &chars[..]),
    };
    let fits = |start: usize| {
        start + chars.len() <= cand.len() && cand[start..start + chars.len()] == *chars
    };
    if first && !wild {
        return fits(at) && match_pieces(rest, cand, at + chars.len(), false);
    }
    // A later piece starts with its delimiter, or with `*`, and may match
    // anywhere further on.
    (at..=cand.len()).any(|start| fits(start) && match_pieces(rest, cand, start + chars.len(), false))
}

/// Flex completion: the input's characters appear in the candidate in order.
fn flex_match(input: &str, candidate: &str) -> bool {
    let mut rest = candidate.chars();
    input.chars().all(|c| rest.any(|d| d == c))
}

/// The longest prefix all the strings share.
pub fn common_prefix(items: &[String]) -> String {
    let Some(first) = items.first() else { return String::new() };
    let mut len = first.len();
    for item in &items[1..] {
        len = first
            .char_indices()
            .zip(item.chars())
            .take_while(|((_, a), b)| a == b)
            .last()
            .map_or(0, |((i, a), _)| i + a.len_utf8())
            .min(len);
    }
    first[..len].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn partial_completion_matches_word_prefixes() {
        assert!(partial_match("f-f", "find-file"));
        assert!(partial_match("f-f", "find-file-other-window"));
        assert!(partial_match("s-w-b", "split-window-below"));
        assert!(!partial_match("f-f", "fundamental-mode"));
        assert!(partial_match("fi*win", "find-file-other-window"));
        assert!(!partial_match("ile", "find-file"));
        assert!(partial_match("", "anything"));
    }

    #[test]
    fn the_first_style_that_matches_decides() {
        let candidates = names(&["find-file", "find-file-other-window", "kill-buffer", "write-file"]);
        let styles = names(&["basic", "partial-completion", "substring"]);
        assert_eq!(complete(&styles, "find", &candidates), ["find-file", "find-file-other-window"]);
        assert_eq!(complete(&styles, "f-f-o", &candidates), ["find-file-other-window"]);
        assert_eq!(complete(&styles, "file", &candidates), ["find-file", "find-file-other-window", "write-file"]);
        assert!(complete(&styles, "zzz", &candidates).is_empty());
        assert_eq!(complete(&names(&["flex"]), "kbf", &candidates), ["kill-buffer"]);
    }

    #[test]
    fn common_prefixes() {
        assert_eq!(common_prefix(&names(&["find-file", "find-file-other-window"])), "find-file");
        assert_eq!(common_prefix(&names(&["über", "übel"])), "übe");
        assert_eq!(common_prefix(&[]), "");
    }
}
