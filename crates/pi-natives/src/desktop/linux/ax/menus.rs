use std::fmt::Write as _;

use super::*;
use crate::desktop::{
	control,
	menus::{DesktopMenuItem, match_index, require_command, require_enabled},
};

const NODE_LIMIT: usize = 2048;
const DEPTH_LIMIT: usize = 32;

fn failure(message: impl std::fmt::Display) -> DesktopError {
	DesktopError::ax_failed(format!("AT-SPI menu: {message}"))
}

const fn menu_role(role: Role) -> bool {
	matches!(
		role,
		Role::Menu | Role::PopupMenu | Role::MenuItem | Role::CheckMenuItem | Role::RadioMenuItem
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn empty_lazy_submenu_still_closes_when_expanded() {
		let expanded = atspi::StateSet::new(State::Showing | State::Expandable | State::Expanded);
		assert!(menu_needs_close(expanded, None).unwrap());
		let closed = atspi::StateSet::new(State::Showing | State::Expandable);
		assert!(!menu_needs_close(closed, None).unwrap());
		assert!(menu_needs_close(atspi::StateSet::new(State::Showing), None).is_err());
		assert_eq!(menu_close_index(["activate", "cancel"].into_iter()), Some(1));
	}

	#[test]
	fn command_requires_one_declared_activation() {
		assert!(command_index(std::iter::empty()).is_err());
		assert!(command_index(["show", "open", "focus"].into_iter()).is_err());
		assert!(command_index(["click", "activate"].into_iter()).is_err());
		assert!(command_index(["press", "PRESS"].into_iter()).is_err());
		assert_eq!(command_index(["show", "aCtIvAtE"].into_iter()).unwrap(), 1);
	}

	#[test]
	fn non_menu_controls_are_not_commands() {
		assert!(!menu_role(Role::Button));
		assert!(!menu_role(Role::Frame));
		assert!(!menu_role(Role::MenuBar));
		assert!(menu_role(Role::CheckMenuItem));
		assert!(menu_role(Role::RadioMenuItem));
	}
}

fn menu_toggle_index<'a>(names: impl Iterator<Item = &'a str>) -> CoreResult<i32> {
	names
		.enumerate()
		.find_map(|(index, name)| {
			["click", "press", "activate"]
				.iter()
				.any(|action| name.eq_ignore_ascii_case(action))
				.then_some(i32::try_from(index).ok())
				.flatten()
		})
		.ok_or_else(|| failure("menu item has no activation action"))
}
fn menu_close_index<'a>(names: impl Iterator<Item = &'a str>) -> Option<i32> {
	names.enumerate().find_map(|(index, name)| {
		["close", "cancel", "dismiss", "hide"]
			.iter()
			.any(|close| name.eq_ignore_ascii_case(close))
			.then(|| i32::try_from(index).ok())
			.flatten()
	})
}

fn menu_needs_close(state: atspi::StateSet, children_showing: Option<bool>) -> CoreResult<bool> {
	if state.contains(State::Defunct) || !state.contains(State::Showing) {
		return Ok(false);
	}
	if state.contains(State::Expanded) {
		return Ok(true);
	}
	if state.contains(State::Expandable) {
		return Ok(false);
	}
	children_showing.ok_or_else(|| failure("popup visibility cannot be confirmed for cleanup"))
}

fn command_index<'a>(names: impl Iterator<Item = &'a str>) -> CoreResult<i32> {
	let mut candidates = names.enumerate().filter(|(_, name)| {
		["click", "press", "activate", "invoke", "toggle", "check", "uncheck"]
			.iter()
			.any(|command| name.eq_ignore_ascii_case(command))
	});
	match (candidates.next(), candidates.next()) {
		(Some((index, _)), None) => i32::try_from(index).map_err(failure),
		_ => Err(failure("command has no unique declared activation action")),
	}
}

impl AtSpiAx {
	// Check parent links as well as child links: a detached popup or a menu
	// belonging to another frame must never become a background command target.
	async fn menu_children(&self, object: &ObjectRefOwned) -> CoreResult<Vec<ObjectRefOwned>> {
		let proxy = object
			.as_accessible_proxy(self.connection.connection())
			.await
			.map_err(failure)?;
		let children = proxy.get_children().await.map_err(failure)?;
		if children.len() > NODE_LIMIT {
			return Err(failure("child limit exceeded"));
		}
		for child in &children {
			if child.is_null() || child == object || child.name() != object.name() {
				return Err(failure("invalid or cross-application child ownership"));
			}
			let proxy = child
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(failure)?;
			if proxy.parent().await.map_err(failure)? != *object {
				return Err(failure("menu child has inconsistent parent ownership"));
			}
		}
		Ok(children)
	}

	async fn open_lazy_submenu(
		&self,
		object: &ObjectRefOwned,
		opened: &mut Vec<ObjectRefOwned>,
	) -> CoreResult<Vec<ObjectRefOwned>> {
		let action = Self::action(&self.connection, object).await.ok();
		let Some(action) = action else {
			return Ok(Vec::new());
		};
		let actions = action.get_actions().await.map_err(failure)?;
		let Ok(index) = menu_toggle_index(actions.iter().map(|action| action.name.as_str())) else {
			return Ok(Vec::new());
		};
		let accessible = object
			.as_accessible_proxy(self.connection.connection())
			.await
			.map_err(failure)?;
		let state = accessible.get_state().await.map_err(failure)?;
		if state.contains(State::Expanded) {
			return self.menu_children(object).await;
		}
		if !state.contains(State::Expandable)
			&& menu_close_index(actions.iter().map(|action| action.name.as_str())).is_none()
		{
			return Err(failure(
				"lazy submenu exposes neither expanded state nor a safe closing action",
			));
		}
		control::check()?;
		// Record before dispatch: even a failed reply may have opened the popup.
		opened.push(object.clone());
		if !action.do_action(index).await.map_err(failure)? {
			opened.pop();
			return Ok(Vec::new());
		}
		for _ in 0..50 {
			control::check()?;
			let children = self.menu_children(object).await?;
			if !children.is_empty() {
				return Ok(children);
			}
			tokio::time::sleep(std::time::Duration::from_millis(10)).await;
		}
		Ok(Vec::new())
	}

	async fn close_menu(&self, object: &ObjectRefOwned) -> CoreResult<()> {
		let action = Self::action(&self.connection, object)
			.await
			.map_err(failure)?;
		let actions = action.get_actions().await.map_err(failure)?;
		let explicit_close = menu_close_index(actions.iter().map(|action| action.name.as_str()));
		let index = if let Some(index) = explicit_close {
			index
		} else {
			let accessible = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(failure)?;
			let state = accessible.get_state().await.map_err(failure)?;
			let children = if state.contains(State::Expanded)
				|| state.contains(State::Expandable)
				|| !state.contains(State::Showing)
			{
				Vec::new()
			} else {
				self.menu_children(object).await?
			};
			let visible = if children.is_empty() {
				None
			} else {
				let mut visible = false;
				for child in children {
					let proxy = child
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(failure)?;
					visible |= proxy
						.get_state()
						.await
						.map_err(failure)?
						.contains(State::Showing);
				}
				Some(visible)
			};
			if !menu_needs_close(state, visible)? {
				return Ok(());
			}
			menu_toggle_index(actions.iter().map(|action| action.name.as_str()))?
		};
		if !action.do_action(index).await.map_err(failure)? {
			return Err(failure("application refused to close the menu"));
		}
		Ok(())
	}

	fn finish_menus<T>(&self, result: CoreResult<T>, opened: Vec<ObjectRefOwned>) -> CoreResult<T> {
		let cleaned = control::cleanup(|| {
			self.rt.block_on(async {
				let mut errors = Vec::new();
				for object in opened.iter().rev() {
					if let Err(error) = self.close_menu(object).await {
						errors.push(error.to_string());
					}
				}
				if errors.is_empty() {
					Ok(())
				} else {
					Err(failure(errors.join("; ")))
				}
			})
		});
		match (result, cleaned) {
			(Ok(value), Ok(())) => Ok(value),
			(Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
			(Err(mut error), Err(cleanup)) => {
				let _ = write!(error.message, "; menu cleanup failed: {cleanup}");
				Err(error)
			},
		}
	}

	async fn menu_bars(&self, root: &ObjectRefOwned) -> CoreResult<Vec<ObjectRefOwned>> {
		let mut pending = vec![(root.clone(), 0)];
		let mut seen = Vec::new();
		let mut bars = Vec::new();
		while let Some((object, depth)) = pending.pop() {
			if depth > DEPTH_LIMIT || seen.len() >= NODE_LIMIT || seen.contains(&object) {
				return Err(failure("menu discovery exceeded its bounded tree or found a cycle"));
			}
			seen.push(object.clone());
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(failure)?;
			let role = proxy.get_role().await.map_err(failure)?;
			if role == Role::MenuBar {
				drop(proxy);
				bars.push(object);
				continue;
			}
			// Menus are chrome, not document content, and nested top-level windows
			// are separate destinations even when owned by the same application.
			if object != *root
				&& !matches!(role, Role::Panel | Role::Filler | Role::RootPane | Role::LayeredPane)
			{
				continue;
			}
			let children = self.menu_children(&object).await?;
			if pending.len() + seen.len() + children.len() > NODE_LIMIT {
				return Err(failure("menu discovery node limit exceeded"));
			}
			pending.extend(children.into_iter().map(|child| (child, depth + 1)));
		}
		if bars.is_empty() {
			return Err(failure(
				"target frame exposes no accessible menu bar; global or detached menus are not \
				 target-bound",
			));
		}
		Ok(bars)
	}

	async fn menu_level(
		&self,
		containers: &[ObjectRefOwned],
		path: &[String],
		opened: &mut Vec<ObjectRefOwned>,
	) -> CoreResult<(Vec<DesktopMenuItem>, Vec<ObjectRefOwned>)> {
		let mut items = Vec::new();
		let mut objects = Vec::new();
		for container in containers {
			let owner = container
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(failure)?;
			let owner_role = owner.get_role().await.map_err(failure)?;
			let owner_name = owner.name().await.map_err(failure)?;
			let mut children = self.menu_children(container).await?;
			// Some toolkits expose a submenu as an intermediate Menu object.
			if owner_role != Role::MenuBar && children.len() == 1 {
				let wrapped = {
					let child = children[0]
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(failure)?;
					let name = child.name().await.map_err(failure)?;
					matches!(child.get_role().await.map_err(failure)?, Role::Menu | Role::PopupMenu)
						&& (name.is_empty() || name == owner_name)
				};
				if wrapped {
					children = self.menu_children(&children[0]).await?;
				}
			}
			for object in children {
				if objects.len() >= NODE_LIMIT {
					return Err(failure("menu item limit exceeded"));
				}
				let proxy = object
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(failure)?;
				let role = proxy.get_role().await.map_err(failure)?;
				if role == Role::Separator {
					continue;
				}
				if !menu_role(role) {
					return Err(failure("menu contains an unsupported non-menu child"));
				}
				let title = proxy.name().await.map_err(failure)?;
				let state = proxy.get_state().await.map_err(failure)?;
				if state.contains(State::Defunct) {
					return Err(failure("menu item is defunct"));
				}
				let mut submenu_children = self.menu_children(&object).await?;
				if path.is_empty()
					&& submenu_children.is_empty()
					&& matches!(role, Role::MenuItem | Role::CheckMenuItem | Role::RadioMenuItem)
				{
					submenu_children = self.open_lazy_submenu(&object, opened).await?;
				}
				let mut has_submenu = role == Role::Menu;
				for child in submenu_children {
					let child_proxy = child
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(failure)?;
					has_submenu |= menu_role(child_proxy.get_role().await.map_err(failure)?);
				}
				let shortcut = match Self::action(&self.connection, &object).await {
					Ok(action) => action
						.get_key_binding(0)
						.await
						.ok()
						.filter(|binding| !binding.is_empty()),
					Err(_) => None,
				};
				let mut item_path = path.to_vec();
				item_path.push(title.clone());
				items.push(DesktopMenuItem {
					title,
					path: item_path,
					enabled: state.contains(State::Enabled) && state.contains(State::Sensitive),
					checked: state.contains(State::Checked),
					has_submenu,
					shortcut,
				});
				drop(proxy);
				objects.push(object);
			}
		}
		if items.is_empty() {
			return Err(failure(
				"menu children are absent or inaccessible without opening a foreground popup",
			));
		}
		Ok((items, objects))
	}

	async fn resolve_menu(
		&self,
		root: &ObjectRefOwned,
		path: &[String],
		opened: &mut Vec<ObjectRefOwned>,
	) -> CoreResult<(DesktopMenuItem, ObjectRefOwned, ObjectRefOwned)> {
		let mut containers = self.menu_bars(root).await?;
		let mut canonical = Vec::new();
		let mut menu_root = None;
		for (depth, label) in path.iter().enumerate() {
			let (mut items, mut objects) = self.menu_level(&containers, &canonical, opened).await?;
			let index = match_index(&items, label)?;
			let item = items.remove(index);
			require_enabled(&item)?;
			let object = objects.remove(index);
			if depth == 0 {
				menu_root = Some(object.clone());
			}
			if depth + 1 == path.len() {
				return Ok((item, object, menu_root.expect("menu path has a root")));
			}
			if !item.has_submenu {
				return Err(failure("path traverses a command rather than a submenu"));
			}
			canonical = item.path;
			containers = vec![object];
		}
		Err(failure("a command path is required"))
	}

	pub(crate) fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<DesktopMenuItem>> {
		let root = self.window_root(window)?;
		let root = Self::object(&root);
		let mut opened = Vec::new();
		let result = self.rt.block_on(async {
			let (containers, canonical) = if path.is_empty() {
				(self.menu_bars(root).await?, Vec::new())
			} else {
				let (item, object, _) = self.resolve_menu(root, path, &mut opened).await?;
				if !item.has_submenu {
					return Err(failure("requested item is not a submenu"));
				}
				(vec![object], item.path)
			};
			let (items, _) = self
				.menu_level(&containers, &canonical, &mut opened)
				.await?;
			Ok(items)
		});
		self.finish_menus(result, opened)
	}

	pub(crate) fn menu_select(&mut self, window: &DesktopWindow, path: &[String]) -> CoreResult<()> {
		let root = self.window_root(window)?;
		let root = Self::object(&root).clone();
		let mut opened = Vec::new();
		let result = (|| {
			let (item, object, _menu_root) =
				self
					.rt
					.block_on(self.resolve_menu(&root, path, &mut opened))?;
			require_command(&item)?;
			// Recheck the resolver and ancestor chain after discovery, before
			// dispatch.
			if Self::object(&self.window_root(window)?) != &root {
				return Err(failure("target frame changed during menu discovery"));
			}
			let handle = AxHandle::AtSpi(object.clone());
			if self.window_id(&handle, std::slice::from_ref(window))? != window.id {
				return Err(failure("command no longer belongs to the target frame"));
			}
			self.rt.block_on(async {
				let (current, current_object, _menu_root) =
					self.resolve_menu(&root, path, &mut opened).await?;
				require_command(&current)?;
				if current_object != object {
					return Err(failure("menu command changed during discovery"));
				}
				let action = Self::action(&self.connection, &object)
					.await
					.map_err(failure)?;
				let actions = action.get_actions().await.map_err(failure)?;
				let index = command_index(actions.iter().map(|action| action.name.as_str()))?;
				control::check()?;
				if !action.do_action(index).await.map_err(failure)? {
					return Err(failure("application refused the menu command"));
				}
				Ok(())
			})
		})();
		self.finish_menus(result, opened)
	}
}
