# Register-then-apply single-person, using the profile-driven filler.
param firstName = "Hollis"
param person = "Hollis Prewitt"
click section "HCR Cases and Outcomes"
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "${firstName}" as First Name
click button "Search"
click link "${person} - *" in "Search Results"
click tabmenu "New Application"
fill application from single
