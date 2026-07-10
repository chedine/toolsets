# Evidence edit flow: dashboard -> Income -> expand member row -> nested
# change record (own iframe) -> assert -> edit -> save -> apply changes.
click section "HCR Cases and Outcomes"
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "bo" as First Name
click button "Search"
click link in "Search Results" at row 1
click link in "Current Cases" where Type = "Insurance Affordability"
select nav "Evidence"
select navitem "Dashboard"
click link "Income"
expand row where Participant = "Bo Stokes"
expand row where Status = "Active"
expect "Amount" is "$589.00"
click rowmenu "Edit" where Status = "Active"
enter "589.00" as Amount
click button "Save"
select tab "Insurance Affordability * - Bo Stokes"
select navitem "Dashboard"
click pagemenu "Apply Changes"
check row where Type = "Income"
click button "Save"
